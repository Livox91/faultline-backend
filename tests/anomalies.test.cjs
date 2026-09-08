require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  InMemoryRuleEngine,
  createDefaultRules,
  OomKilledRule,
  CrashLoopRule,
  HighMemoryUtilizationRule,
  HighCpuUtilizationRule,
  PodNotReadyRule,
  DeploymentDegradedRule,
  FailedSchedulingRule,
  ImagePullFailureRule,
  FailedMountRule,
  NodeNotReadyRule,
} = require('../apps/processor/dist/rules');

const thresholds = {
  memoryWarningPercent: 85,
  memoryCriticalPercent: 95,
  cpuWarningPercent: 80,
  cpuCriticalPercent: 95,
  restartThreshold: 3,
  notReadyDurationMs: 1000,
  deploymentDegradationDurationMs: 2000,
};
const origin = Date.parse('2026-09-08T10:00:00Z');
let sequence = 0;
const timestamp = (offset) => new Date(origin + offset).toISOString();
const metric = (name, offset, overrides = {}) => ({
  id: `metric-${++sequence}`,
  kind: 'metric',
  clusterId: 'production-01',
  namespace: 'payments',
  workload: 'payment-api',
  pod: 'payment-api-abc123',
  container: 'api',
  node: 'worker-1',
  timestamp: timestamp(offset),
  ingestedAt: timestamp(offset),
  name,
  value: 1,
  unit: '1',
  metricType: 'gauge',
  attributes: { 'k8s.pod.uid': 'pod-uid-1' },
  raw: null,
  ...overrides,
});
const state = (scope, offset, overrides = {}) => ({
  scope,
  clusterId: 'production-01',
  namespace: scope === 'node' ? undefined : 'payments',
  workload: scope === 'node' ? undefined : 'payment-api',
  pod:
    scope === 'deployment' || scope === 'node'
      ? undefined
      : 'payment-api-abc123',
  podUid: scope === 'deployment' || scope === 'node' ? undefined : 'pod-uid-1',
  container: scope === 'container' ? 'api' : undefined,
  node: scope === 'deployment' ? undefined : 'worker-1',
  updatedAt: timestamp(offset),
  fieldTimestamps: {},
  ...overrides,
});
const kubeEvent = (reason, offset, overrides = {}) => ({
  id: `event-${++sequence}`,
  kind: 'kubernetes',
  clusterId: 'production-01',
  namespace: 'payments',
  workload: 'payment-api',
  pod: 'payment-api-abc123',
  container: 'api',
  timestamp: timestamp(offset),
  ingestedAt: timestamp(offset),
  type: 'Warning',
  reason,
  message: reason,
  involvedObject: {
    clusterId: 'production-01',
    apiVersion: 'v1',
    kind: 'Pod',
    name: 'payment-api-abc123',
    namespace: 'payments',
    uid: 'pod-uid-1',
  },
  attributes: { 'k8s.pod.uid': 'pod-uid-1' },
  raw: null,
  ...overrides,
});
const engine = (rule, custom = {}) =>
  new InMemoryRuleEngine([rule], { ...thresholds, ...custom });

test('default rule registry contains every initial classification without a central switch', () => {
  assert.deepEqual(
    createDefaultRules()
      .map((rule) => rule.classification)
      .sort(),
    [
      'OOM_KILLED',
      'CRASH_LOOP',
      'HIGH_MEMORY_UTILIZATION',
      'HIGH_CPU_UTILIZATION',
      'POD_NOT_READY',
      'DEPLOYMENT_DEGRADED',
      'FAILED_SCHEDULING',
      'IMAGE_PULL_FAILURE',
      'FAILED_MOUNT',
      'NODE_NOT_READY',
    ].sort(),
  );
});

test('HIGH_MEMORY_UTILIZATION requires repeated samples, includes warning/critical boundaries, deduplicates and resolves', () => {
  const rules = engine(new HighMemoryUtilizationRule());
  assert.deepEqual(
    rules.evaluate(
      metric('k8s.container.memory.usage', 0),
      state('container', 0),
    ),
    [],
  );
  assert.deepEqual(
    rules.evaluate(
      metric('k8s.container.memory.usage', 100),
      state('container', 100, { memoryUtilizationPercent: 84.99 }),
    ),
    [],
  );
  assert.deepEqual(
    rules.evaluate(
      metric('k8s.container.memory.usage', 200),
      state('container', 200, { memoryUtilizationPercent: 85 }),
    ),
    [],
  );
  const opened = rules.evaluate(
    metric('k8s.container.memory.usage', 300),
    state('container', 300, { memoryUtilizationPercent: 85 }),
  )[0];
  assert.equal(opened.status, 'OPEN');
  assert.equal(opened.severity, 'WARNING');
  const activating = metric('k8s.container.memory.usage', 400);
  const active = rules.evaluate(
    activating,
    state('container', 400, { memoryUtilizationPercent: 95 }),
  )[0];
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.severity, 'CRITICAL');
  assert.equal(active.anomalyId, opened.anomalyId);
  assert.deepEqual(
    rules.evaluate(
      activating,
      state('container', 400, { memoryUtilizationPercent: 99 }),
    ),
    [],
  );
  assert.deepEqual(
    rules.evaluate(
      metric('k8s.container.memory.usage', 500),
      state('container', 500, { memoryUtilizationPercent: 99 }),
    ),
    [],
  );
  const resolved = rules.evaluate(
    metric('k8s.container.memory.usage', 600),
    state('container', 600, { memoryUtilizationPercent: 84.99 }),
  )[0];
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.anomalyId, opened.anomalyId);
  assert.deepEqual(
    rules.evaluate(
      metric('k8s.container.memory.usage', 550),
      state('container', 550, { memoryUtilizationPercent: 99 }),
    ),
    [],
  );
});

test('HIGH_CPU_UTILIZATION detects its exact boundaries and ignores missing utilization', () => {
  const rules = engine(new HighCpuUtilizationRule());
  assert.deepEqual(
    rules.evaluate(metric('k8s.container.cpu.usage', 0), state('container', 0)),
    [],
  );
  rules.evaluate(
    metric('k8s.container.cpu.usage', 10),
    state('container', 10, { cpuUtilizationPercent: 80 }),
  );
  const warning = rules.evaluate(
    metric('k8s.container.cpu.usage', 20),
    state('container', 20, { cpuUtilizationPercent: 80 }),
  )[0];
  assert.equal(warning.classification, 'HIGH_CPU_UTILIZATION');
  assert.equal(warning.severity, 'WARNING');
  const active = rules.evaluate(
    metric('k8s.container.cpu.usage', 30),
    state('container', 30, { cpuUtilizationPercent: 95 }),
  )[0];
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.severity, 'CRITICAL');
  assert.equal(
    rules.evaluate(
      metric('k8s.container.cpu.usage', 40),
      state('container', 40, { cpuUtilizationPercent: 79.99 }),
    )[0].status,
    'RESOLVED',
  );
});

test('OOM_KILLED uses Kubernetes-native evidence, correlates optional state, deduplicates and resolves', () => {
  const rules = engine(new OomKilledRule());
  assert.deepEqual(rules.evaluate(kubeEvent('Started', 0)), []);
  const current = state('container', 10, {
    memoryUtilizationPercent: 97,
    lastTerminationReason: 'OOMKilled',
    containerState: 'running',
    previousRestartCount: 2,
    restartCount: 3,
    restartDelta: 1,
  });
  const firstEvent = kubeEvent('OOMKilled', 10);
  const opened = rules.evaluate(firstEvent, current)[0];
  assert.equal(opened.status, 'OPEN');
  assert.equal(opened.severity, 'CRITICAL');
  assert.equal(opened.confidence, 1);
  assert.equal(opened.evidence.length, 4);
  assert.deepEqual(rules.evaluate(firstEvent, current), []);
  assert.equal(
    rules.evaluate(kubeEvent('OOMKilled', 20), current)[0].status,
    'ACTIVE',
  );
  const resolved = rules.evaluate(
    metric('k8s.container.restart_count', 30),
    state('container', 30, {
      containerState: 'running',
      lastTerminationReason: 'OOMKilled',
      restartDelta: 0,
    }),
  )[0];
  assert.equal(resolved.status, 'RESOLVED');
});

test('CRASH_LOOP requires repeated restart increases plus backoff evidence and handles ordering', () => {
  const rules = engine(new CrashLoopRule());
  assert.deepEqual(rules.evaluate(kubeEvent('BackOff', 0)), []);
  for (const [offset, count] of [
    [100, 1],
    [200, 2],
  ]) {
    assert.deepEqual(
      rules.evaluate(
        metric('k8s.container.restart_count', offset),
        state('container', offset, {
          restartCount: count,
          restartDelta: 1,
          containerState: 'waiting',
          containerStateReason: 'CrashLoopBackOff',
        }),
      ),
      [],
    );
  }
  const opened = rules.evaluate(
    metric('k8s.container.restart_count', 300),
    state('container', 300, {
      restartCount: 3,
      restartDelta: 1,
      containerState: 'waiting',
      containerStateReason: 'CrashLoopBackOff',
    }),
  )[0];
  assert.equal(opened.status, 'OPEN');
  assert.equal(opened.classification, 'CRASH_LOOP');
  assert.ok(opened.evidence.some((item) => item.eventId));
  assert.deepEqual(
    rules.evaluate(
      metric('k8s.container.restart_count', 250),
      state('container', 250, { restartCount: 4, restartDelta: 1 }),
    ),
    [],
  );
  assert.equal(
    rules.evaluate(
      metric('k8s.container.restart_count', 400),
      state('container', 400, {
        restartCount: 4,
        restartDelta: 1,
        containerState: 'waiting',
      }),
    )[0].status,
    'ACTIVE',
  );
  assert.deepEqual(
    rules.evaluate(
      metric('k8s.container.restart_count', 500),
      state('container', 500, {
        restartCount: 5,
        restartDelta: 1,
        containerState: 'waiting',
      }),
    ),
    [],
  );
  assert.equal(
    rules.evaluate(
      metric('k8s.container.restart_count', 600),
      state('container', 600, {
        restartCount: 5,
        restartDelta: 0,
        containerState: 'running',
      }),
    )[0].status,
    'RESOLVED',
  );
  const noBackoff = engine(new CrashLoopRule());
  for (let count = 1; count <= 4; count++)
    assert.deepEqual(
      noBackoff.evaluate(
        metric('k8s.container.restart_count', count * 10),
        state('container', count * 10, {
          restartCount: count,
          restartDelta: 1,
        }),
      ),
      [],
    );
});

test('POD_NOT_READY observes the configured duration boundary and resolves', () => {
  const rules = engine(new PodNotReadyRule());
  const event = (offset) =>
    metric('k8s.pod.ready', offset, {
      pod: 'payment-api-abc123',
      container: undefined,
    });
  assert.deepEqual(
    rules.evaluate(event(0), state('pod', 0, { ready: false })),
    [],
  );
  assert.deepEqual(
    rules.evaluate(event(999), state('pod', 999, { ready: false })),
    [],
  );
  const opened = rules.evaluate(
    event(1000),
    state('pod', 1000, { ready: false }),
  )[0];
  assert.equal(opened.classification, 'POD_NOT_READY');
  assert.equal(opened.status, 'OPEN');
  assert.equal(
    rules.evaluate(event(1100), state('pod', 1100, { ready: true }))[0].status,
    'RESOLVED',
  );
});

test('DEPLOYMENT_DEGRADED waits for duration, handles boundaries and resolves', () => {
  const rules = engine(new DeploymentDegradedRule());
  const event = (offset) =>
    metric('k8s.deployment.replicas.available', offset, {
      pod: undefined,
      container: undefined,
    });
  assert.deepEqual(
    rules.evaluate(
      event(0),
      state('deployment', 0, { desiredReplicas: 3, availableReplicas: 3 }),
    ),
    [],
  );
  assert.deepEqual(
    rules.evaluate(
      event(100),
      state('deployment', 100, { desiredReplicas: 3, availableReplicas: 2 }),
    ),
    [],
  );
  assert.deepEqual(
    rules.evaluate(
      event(2099),
      state('deployment', 2099, { desiredReplicas: 3, availableReplicas: 2 }),
    ),
    [],
  );
  const opened = rules.evaluate(
    event(2100),
    state('deployment', 2100, { desiredReplicas: 3, availableReplicas: 0 }),
  )[0];
  assert.equal(opened.classification, 'DEPLOYMENT_DEGRADED');
  assert.equal(opened.severity, 'CRITICAL');
  assert.equal(
    rules.evaluate(
      event(2200),
      state('deployment', 2200, { desiredReplicas: 3, availableReplicas: 3 }),
    )[0].status,
    'RESOLVED',
  );
  assert.deepEqual(
    rules.evaluate(
      event(2300),
      state('deployment', 2300, { desiredReplicas: 3 }),
    ),
    [],
  );
});

test('NODE_NOT_READY waits for duration, rejects unknown condition and resolves', () => {
  const rules = engine(new NodeNotReadyRule());
  const event = (offset) =>
    metric('k8s.node.condition_ready', offset, {
      namespace: undefined,
      workload: undefined,
      pod: undefined,
      container: undefined,
    });
  assert.deepEqual(
    rules.evaluate(
      event(0),
      state('node', 0, { nodeConditions: { ready: null } }),
    ),
    [],
  );
  assert.deepEqual(
    rules.evaluate(
      event(10),
      state('node', 10, { nodeConditions: { ready: false } }),
    ),
    [],
  );
  const opened = rules.evaluate(
    event(1010),
    state('node', 1010, { nodeConditions: { ready: false } }),
  )[0];
  assert.equal(opened.classification, 'NODE_NOT_READY');
  assert.equal(opened.severity, 'CRITICAL');
  assert.equal(
    rules.evaluate(
      event(1020),
      state('node', 1020, { nodeConditions: { ready: true } }),
    )[0].status,
    'RESOLVED',
  );
});

for (const [Rule, reason, classification] of [
  [FailedSchedulingRule, 'FailedScheduling', 'FAILED_SCHEDULING'],
  [ImagePullFailureRule, 'ImagePullBackOff', 'IMAGE_PULL_FAILURE'],
  [FailedMountRule, 'FailedMount', 'FAILED_MOUNT'],
]) {
  test(`${classification} detects native Kubernetes evidence, ignores other reasons and resolves`, () => {
    const rules = engine(new Rule());
    assert.deepEqual(rules.evaluate(kubeEvent('Started', 0)), []);
    const opened = rules.evaluate(kubeEvent(reason, 10))[0];
    assert.equal(opened.classification, classification);
    assert.equal(opened.status, 'OPEN');
    assert.equal(opened.confidence, 1);
    assert.ok(opened.evidence[0].eventId);
    assert.equal(rules.evaluate(kubeEvent(reason, 20))[0].status, 'ACTIVE');
    assert.deepEqual(rules.evaluate(kubeEvent(reason, 30)), []);
    const healthy = metric('k8s.pod.ready', 40, { container: undefined });
    assert.equal(
      rules.evaluate(healthy, state('pod', 40, { ready: true }))[0].status,
      'RESOLVED',
    );
  });
}

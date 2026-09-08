require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  ApplicationLogger,
  APPLICATION_CONFIG,
} = require('@faultline/platform');
const { QUEUE, InMemoryQueue } = require('@faultline/queue');
const {
  metricEventSchema,
  normalizeWorkloadSnapshot,
} = require('@faultline/telemetry');
const {
  InMemoryResourceState,
} = require('../apps/processor/dist/resource-state/in-memory-resource-state');
const {
  utilizationPercent,
  restartChange,
} = require('../apps/processor/dist/resource-state/calculations');
const {
  TelemetryConsumer,
} = require('../apps/processor/dist/telemetry.consumer');
const {
  OtlpController,
} = require('../apps/ingestion/dist/otlp/otlp.controller');
const {
  TelemetryController,
  CLUSTER_AUTHENTICATOR,
  DevelopmentClusterAuthenticator,
} = require('../apps/ingestion/dist/telemetry.controller');
const { translateOtlpMetrics } = require('../apps/ingestion/dist/otlp/metrics');
const { configureIngestionHttp } = require('../apps/ingestion/dist/otlp/http');
const now = Date.now();
test('unknown metric/condition names cannot create unbounded state fields', () => {
  const store = new InMemoryResourceState(120000, 10, () => now + 1000);
  assert.equal(
    store.update(event('unused', 1, '1', 0, { name: '__proto__' })),
    undefined,
  );
  assert.equal(
    store.update(
      event('unused', 1, '1', 0, { name: 'k8s.node.condition_custom' }),
    ),
    undefined,
  );
  assert.deepEqual(
    store.update(
      event('unused', 1, '1', 0, { name: 'k8s.node.condition_ready' }),
    ).nodeConditions,
    { ready: true },
  );
});
const at = (offset = 0) => new Date(now + offset).toISOString();
const event = (name, value, unit = '1', offset = 0, extra = {}) =>
  metricEventSchema.parse({
    id: String(Math.random()),
    kind: 'metric',
    clusterId: 'cluster-1',
    timestamp: at(offset),
    ingestedAt: at(),
    namespace: 'payments',
    pod: 'api-1',
    container: 'api',
    node: 'worker',
    name: 'k8s.container.' + name,
    value,
    unit,
    metricType: 'gauge',
    attributes: { 'k8s.pod.uid': 'uid-1' },
    raw: null,
    ...extra,
  });

test('resource state joins usage and configuration in bytes/cores, and snapshots are isolated', () => {
  const store = new InMemoryResourceState(120000, 10, () => now + 1000);
  store.update(event('memory.usage', 460, 'MiB'));
  store.update(event('cpu.usage', 125, 'millicores'));
  store.update(event('memory.limit', 512, 'MiB'));
  const state = store.update(event('cpu.limit', 0.5, 'cores'));
  assert.equal(state.memoryUsage, 460 * 1024 ** 2);
  assert.equal(state.memoryUtilizationPercent, 89.84);
  assert.equal(state.cpuUsage, 0.125);
  assert.equal(state.cpuUtilizationPercent, 25);
  state.memoryUsage = 0;
  assert.equal(store.get(state).memoryUsage, 460 * 1024 ** 2);
  assert.equal(store.update(event('cpu.usage', 1, 's', 1)), undefined);
  assert.equal(
    store.update(event('cpu.usage', 1, 'cores', 1, { metricType: 'counter' })),
    undefined,
  );
});

test('missing, zero and invalid limits produce no utilization or classification', () => {
  const store = new InMemoryResourceState(120000, 10, () => now + 1000);
  assert.equal(
    store.update(event('memory.usage', 460, 'MiB')).memoryUtilizationPercent,
    undefined,
  );
  assert.equal(
    store.update(event('memory.limit', 0, 'MiB')).memoryUtilizationPercent,
    undefined,
  );
  for (const pair of [
    [1, undefined],
    [undefined, 1],
    [1, 0],
    [1, -1],
    [NaN, 1],
    [1, Infinity],
  ])
    assert.equal(utilizationPercent(...pair), undefined);
  assert.equal(utilizationPercent(2, 1), 200); // Not clamped or classified.
});

test('older and duplicate samples cannot overwrite newer values; nanoseconds are retained', () => {
  const store = new InMemoryResourceState(120000, 10, () => now + 1000);
  const sample = event('memory.usage', 50, 'By', 100);
  const latest = store.update(sample);
  assert.equal(store.update({ ...sample, value: 10 }), undefined);
  assert.equal(store.update(event('memory.usage', 20, 'By', 50)), undefined);
  assert.equal(store.get(latest).memoryUsage, 50);
  const nano = at(200).replace('Z', '123456Z');
  assert.ok(
    store.update(event('memory.usage', 60, 'By', 0, { timestamp: nano })),
  );
  assert.equal(
    store.update(
      event('memory.usage', 1, 'By', 0, {
        timestamp: nano.replace('123456', '123455'),
      }),
    ),
    undefined,
  );
});

test('individual stale fields expire even when resource usage is still arriving', () => {
  let clock = now;
  const store = new InMemoryResourceState(1000, 10, () => clock);
  store.update(event('memory.limit', 512, 'MiB'));
  clock += 900;
  const state = store.update(event('memory.usage', 100, 'MiB', 900));
  assert.ok(state.memoryUtilizationPercent > 0);
  clock += 101;
  assert.equal(store.get(state).memoryLimit, undefined);
  assert.equal(store.get(state).memoryUtilizationPercent, undefined);
  assert.equal(store.update(event('memory.limit', 512, 'MiB')), undefined); // Expired replay.
  assert.equal(
    store.update(event('memory.limit', 512, 'MiB', 70000)),
    undefined,
  ); // Clock skew.
  clock += 1000;
  assert.equal(store.get(state), undefined);
});

test('restart changes include previous/current/delta and explicitly handle counter resets', () => {
  const store = new InMemoryResourceState(120000, 10, () => now + 1000);
  assert.equal(store.update(event('restart_count', 2)).restartDelta, undefined);
  const changed = store.update(event('restart_count', 5, '1', 10));
  assert.equal(changed.previousRestartCount, 2);
  assert.equal(changed.restartCount, 5);
  assert.equal(changed.restartDelta, 3);
  assert.equal(store.update(event('restart_count', 3, '1', 5)), undefined);
  const reset = store.update(event('restart_count', 0, '1', 20));
  assert.equal(reset.restartCounterReset, true);
  assert.equal(reset.restartDelta, undefined);
  assert.equal(restartChange(5, 5).restartDelta, 0);
});

test('pod UID, cluster, namespace and container separate resources; capacity is bounded', () => {
  const store = new InMemoryResourceState(120000, 2, () => now + 1000);
  const first = store.update(event('memory.limit', 10, 'MiB'));
  const replacement = store.update(
    event('memory.usage', 3, 'MiB', 0, {
      attributes: { 'k8s.pod.uid': 'uid-2' },
    }),
  );
  assert.equal(replacement.memoryLimit, undefined);
  assert.equal(store.get(first).memoryLimit, 10 * 1024 ** 2);
  store.update(event('memory.usage', 4, 'MiB', 0, { clusterId: 'cluster-2' }));
  assert.equal(store.get(first), undefined);
  assert.ok(store.get(replacement));
});

test('workload snapshots produce structured readiness/state without retaining pod specs', () => {
  const snapshot = {
    kind: 'Pod',
    metadata: { name: 'api-1', namespace: 'payments', uid: 'uid-1' },
    spec: {
      containers: [{ env: [{ name: 'PRIVATE', value: 'do-not-retain' }] }],
    },
    status: {
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [
        {
          name: 'api',
          state: { running: {} },
          lastState: { terminated: { reason: 'Error', exitCode: 1 } },
        },
      ],
    },
  };
  const events = normalizeWorkloadSnapshot(
    snapshot,
    { clusterId: 'cluster-1', timestamp: at(), ingestedAt: at() },
    () => 'id',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].name, 'k8s.pod.ready');
  assert.equal(events[0].value, 0);
  assert.equal(events[1].attributes.state, 'running');
  assert.equal(events[1].attributes.lastTerminationReason, 'Error');
  assert.ok(!JSON.stringify(events).includes('do-not-retain'));
  const store = new InMemoryResourceState(120000, 10, () => now + 1000);
  const state = store.update(events[1]);
  assert.equal(state.containerState, 'running');
  assert.equal(state.lastTerminationReason, 'Error');
  assert.equal(state.terminationReason, null);
});

const attrs = (values) =>
  Object.entries(values).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
const resource = {
  'faultline.cluster.id': 'cluster-1',
  'k8s.namespace.name': 'payments',
  'k8s.pod.name': 'api-1',
  'k8s.pod.uid': 'uid-1',
  'k8s.container.name': 'api',
};
const wirePoint = {
  timeUnixNano: String(BigInt(now) * 1000000n),
  asDouble: 460,
  attributes: [],
};
const metric = (
  name = 'container.memory.usage',
  unit = 'MiB',
  point = wirePoint,
) => ({ name, unit, gauge: { dataPoints: [point] } });
const batch = (metrics = [metric()], metadata = resource) => ({
  resourceMetrics: [
    { resource: { attributes: attrs(metadata) }, scopeMetrics: [{ metrics }] },
  ],
});

test('OTLP scalar metrics normalize vocabulary, preserve timestamps and reject malformed points', () => {
  const normalized = translateOtlpMetrics(batch(), 'cluster-1');
  assert.equal(normalized.events[0].name, 'k8s.container.memory.usage');
  assert.equal(normalized.events[0].unit, 'MiB');
  assert.equal(normalized.events[0].category, 'usage');
  assert.equal(
    translateOtlpMetrics(
      batch([metric('k8s.container.memory_limit')]),
      'cluster-1',
    ).events[0].category,
    'configuration',
  );
  for (const patch of [
    { asDouble: NaN },
    { asDouble: '1' },
    { timeUnixNano: 'bad' },
    { asInt: '1' },
    { flags: 1 },
  ])
    assert.equal(
      translateOtlpMetrics(
        batch([metric('x', '1', { ...wirePoint, ...patch })]),
        'cluster-1',
      ).rejected,
      1,
    );
  assert.equal(
    translateOtlpMetrics(
      batch([
        metric('x', '1', {
          timeUnixNano: wirePoint.timeUnixNano,
          asInt: '9007199254740992',
        }),
      ]),
      'cluster-1',
    ).rejected,
    1,
  );
  assert.equal(
    translateOtlpMetrics(
      batch([metric()], { ...resource, 'faultline.cluster.id': 'other' }),
      'cluster-1',
    ).rejected,
    1,
  );
  assert.throws(
    () => translateOtlpMetrics(batch(Array(257).fill(metric())), 'cluster-1'),
    /256/,
  );
  const unsupported = { name: 'histogram', histogram: { dataPoints: [{}] } };
  assert.equal(
    translateOtlpMetrics(batch([unsupported]), 'cluster-1').rejected,
    1,
  );
});

test('authenticated gzip metric batches reach processor state; REST batches validate before publishing', async () => {
  const logs = [];
  const logger = {
    log: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  };
  const queue = new InMemoryQueue();
  const store = new InMemoryResourceState();
  const consumer = new TelemetryConsumer(queue, logger, store);
  await consumer.onModuleInit();
  class TestModule {}
  Module({
    controllers: [OtlpController, TelemetryController],
    providers: [
      { provide: QUEUE, useValue: queue },
      { provide: ApplicationLogger, useValue: logger },
      {
        provide: APPLICATION_CONFIG,
        useValue: { environment: 'test', developmentAgentToken: 'test-token' },
      },
      {
        provide: CLUSTER_AUTHENTICATOR,
        useClass: DevelopmentClusterAuthenticator,
      },
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  configureIngestionHttp(app);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (path, body, headers = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-faultline-cluster-id': 'cluster-1',
          'x-faultline-agent-token': 'test-token',
          ...headers,
        },
        body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
    const payload = batch([
      metric(),
      metric('k8s.container.memory_limit', 'MiB', {
        ...wirePoint,
        asDouble: 512,
      }),
    ]);
    assert.equal(
      (
        await post('/v1/otlp/metrics', payload, {
          'x-faultline-agent-token': 'wrong',
        })
      ).status,
      401,
    );
    const response = await post(
      '/v1/otlp/metrics',
      gzipSync(JSON.stringify(payload)),
      { 'content-encoding': 'gzip' },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
    await new Promise(setImmediate);
    assert.ok(
      logs.some((entry) => entry.resource?.memoryUtilizationPercent === 89.84),
    );
    const partial = await post(
      '/v1/otlp/metrics',
      batch([metric(), metric('bad', '1', { ...wirePoint, asDouble: 'bad' })]),
    );
    assert.deepEqual(await partial.json(), {
      partialSuccess: {
        rejectedDataPoints: '1',
        errorMessage: 'Malformed telemetry records rejected',
      },
    });
    const rest = {
      timestamp: at(),
      namespace: 'payments',
      pod: 'api-1',
      container: 'api',
      name: 'k8s.container.cpu.usage',
      value: 0.1,
      unit: 'cores',
    };
    const before = logs.filter(
      (entry) => entry.event === 'telemetry_accepted',
    ).length;
    assert.equal(
      (
        await post('/v1/telemetry/metrics', {
          records: [rest, { ...rest, value: 'bad' }],
        })
      ).status,
      400,
    );
    assert.equal(
      logs.filter((entry) => entry.event === 'telemetry_accepted').length,
      before,
    );
    assert.equal(
      (await post('/v1/telemetry/metrics', { records: [] })).status,
      400,
    );
    assert.equal(
      (await post('/v1/telemetry/metrics', { records: Array(257).fill(rest) }))
        .status,
      400,
    );
    const accepted = await post('/v1/telemetry/metrics', {
      records: [rest, { ...rest, name: 'k8s.container.cpu.limit', value: 1 }],
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).accepted, 2);
    await consumer.onModuleDestroy();
    assert.equal((await post('/v1/otlp/metrics', payload)).status, 503);
    assert.ok(!JSON.stringify(logs).includes('test-token'));
  } finally {
    await app.close();
    await consumer.onModuleDestroy();
    await queue.close();
  }
});

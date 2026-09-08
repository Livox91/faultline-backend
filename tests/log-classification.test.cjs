require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  InMemoryLogClassificationRepository,
  LOG_CLASSIFICATION_TAXONOMY_VERSION,
} = require('@faultline/log-classification');
const {
  StagedLogClassifier,
} = require('../apps/processor/dist/log-classification/log-classifier');
const {
  InMemoryStatisticalDetector,
} = require('../apps/processor/dist/statistical/statistical-detector');
const {
  InMemoryRuleEngine,
  createDefaultRules,
} = require('../apps/processor/dist/rules');
const {
  InMemoryResourceState,
} = require('../apps/processor/dist/resource-state/in-memory-resource-state');
const {
  IncidentCorrelationEngine,
} = require('../apps/processor/dist/correlation');
const {
  TelemetryConsumer,
} = require('../apps/processor/dist/telemetry.consumer');
const {
  CachedBaselineProvider,
  InMemoryBaselineRepository,
} = require('@faultline/baselines');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const { InMemoryQueue } = require('@faultline/queue');

const settings = {
  enabled: true,
  minimumConfidence: 0.6,
  highConfidence: 0.85,
  aggregationWindowMs: 600_000,
};
const base = Date.now() - 30_000;
const iso = (offset = 0) => new Date(base + offset).toISOString();
let sequence = 0;

function log(message, extra = {}) {
  return {
    kind: 'log',
    id: `log-classification-${sequence++}`,
    timestamp: iso(sequence * 100),
    ingestedAt: iso(sequence * 100),
    clusterId: 'production-eu',
    namespace: 'payments',
    workload: 'payment-api',
    service: 'payment-api',
    pod: 'payment-api-7d9f-a0001',
    container: 'api',
    level: 'error',
    message,
    attributes: { 'k8s.pod.uid': 'payment-uid' },
    raw: null,
    ...extra,
  };
}

function classifier(
  ml,
  repository = new InMemoryLogClassificationRepository(),
) {
  return {
    repository,
    classifier: new StagedLogClassifier(repository, settings, ml),
  };
}

test('deterministic rules classify stable operational log categories', async (t) => {
  const cases = [
    [
      'ECONNREFUSED while opening PostgreSQL connection',
      'DATABASE_CONNECTIVITY',
    ],
    ['upstream dependency timed out after 5000ms', 'DEPENDENCY_TIMEOUT'],
    ['401 unauthorized: invalid credentials', 'AUTHENTICATION_FAILURE'],
    ['required environment variable DB_URL is not set', 'CONFIGURATION_ERROR'],
    [
      'Unhandled exception: TypeError in request handler',
      'APPLICATION_EXCEPTION',
    ],
    ['429 too many requests; rate limit exceeded', 'RATE_LIMITING'],
  ];
  for (const [message, expected] of cases)
    await t.test(expected, async () => {
      const { classifier: subject } = classifier({
        classify: async () => {
          throw new Error('deterministic matches must not invoke ML');
        },
      });
      const event = log(message);
      const before = structuredClone(event);
      const outcome = await subject.classify(event);
      assert.equal(outcome.result.classification, expected);
      assert.equal(outcome.result.classifierType, 'RULE');
      assert.equal(
        outcome.result.modelVersion,
        LOG_CLASSIFICATION_TAXONOMY_VERSION,
      );
      assert.equal(outcome.anomaly.source, 'LOG_CLASSIFIER');
      assert.deepEqual(
        event,
        before,
        'classification does not mutate LogEvent',
      );
    });
});

test('routine and unknown logs bypass ML or remain UNKNOWN', async () => {
  let calls = 0;
  const { classifier: subject } = classifier({
    classify: async () => {
      calls++;
      return {
        classification: 'APPLICATION_EXCEPTION',
        confidence: 0.9,
        modelVersion: 'ml-v1',
      };
    },
  });
  const normal = await subject.classify(log('health check success'));
  assert.equal(normal.result.classification, 'NORMAL');
  assert.equal(normal.anomaly, undefined);
  assert.equal(calls, 0, 'low-value deterministic logs skip ML');

  const noModel = new StagedLogClassifier(
    new InMemoryLogClassificationRepository(),
    settings,
  );
  const unknown = await noModel.classify(log('opaque business message'));
  assert.equal(unknown.result.classification, 'UNKNOWN');
  assert.equal(unknown.result.classifierType, 'UNKNOWN');
  assert.equal(unknown.anomaly, undefined);
});

test('low-confidence ML becomes UNKNOWN while preserving its model version', async () => {
  const { classifier: subject } = classifier({
    classify: async () => ({
      classification: 'NETWORK_FAILURE',
      confidence: 0.42,
      modelVersion: 'log-classifier-v7',
      evidence: 'weak network wording',
    }),
  });
  const outcome = await subject.classify(log('opaque failure code alpha'));
  assert.equal(outcome.result.classification, 'UNKNOWN');
  assert.equal(outcome.result.classifierType, 'ML');
  assert.equal(outcome.result.confidence, 0.42);
  assert.equal(outcome.result.modelVersion, 'log-classifier-v7');
  assert.equal(outcome.anomaly, undefined);
});

test('accepted ML classifications keep immutable model provenance and reduced confidence', async () => {
  const { classifier: subject } = classifier({
    classify: async () => ({
      classification: 'NETWORK_FAILURE',
      confidence: 0.75,
      modelVersion: 'log-classifier-v8',
    }),
  });
  const outcome = await subject.classify(log('opaque failure code beta'));
  assert.equal(outcome.result.classification, 'NETWORK_FAILURE');
  assert.equal(outcome.result.modelVersion, 'log-classifier-v8');
  assert.equal(outcome.anomaly.ruleId, 'log-classifier.log-classifier-v8');
  assert.equal(outcome.anomaly.confidence, 0.6);
});

test('volatile values group into one bounded pattern aggregate', async () => {
  const { classifier: subject, repository } = classifier();
  const outcomes = [];
  for (const [index, address] of ['10.0.0.5', '10.0.0.6', '10.0.0.7'].entries())
    outcomes.push(
      await subject.classify(
        log(`connection refused ${address}:5432`, {
          pod: `payment-api-7d9f-a000${index}`,
        }),
      ),
    );
  assert.equal(new Set(outcomes.map((item) => item.result.patternId)).size, 1);
  assert.equal(new Set(outcomes.map((item) => item.anomaly.anomalyId)).size, 1);
  const aggregate = await repository.getPattern(outcomes[0].result.patternId);
  const stored = await repository.get(outcomes[0].result.eventId);
  assert.equal(stored.classification, 'DATABASE_CONNECTIVITY');
  assert.equal(stored.evidence[0].excerpt, 'connection refused');
  assert.equal(aggregate.count, 3);
  assert.equal(aggregate.affectedPods.length, 3);
  assert.equal(outcomes[2].anomaly.status, 'ACTIVE');
  assert.equal(outcomes[2].anomaly.evidence[0].attributes.count, 3);

  const restarted = new StagedLogClassifier(repository, settings);
  const afterRestart = await restarted.classify(
    log('connection refused 10.0.0.8:5432', {
      pod: 'payment-api-7d9f-a0003',
    }),
  );
  assert.equal(afterRestart.anomaly.anomalyId, outcomes[0].anomaly.anomalyId);
  assert.equal(afterRestart.aggregate.count, 4);
});

test('classifier failure is non-blocking and emits structured degradation telemetry', async () => {
  const warnings = [];
  const consumer = new TelemetryConsumer(
    new InMemoryQueue(),
    {
      log() {},
      warn(value) {
        warnings.push(value);
      },
      error() {},
      debug() {},
      verbose() {},
    },
    new InMemoryResourceState(),
    { evaluate: () => [] },
    undefined,
    undefined,
    { detect: async () => [] },
    {
      classify: async () => {
        throw new Error('ML unavailable');
      },
    },
  );
  const event = log('opaque message sent to unavailable model');
  const processed = await consumer.process({ id: event.id, payload: event });
  assert.equal(processed.status, 'processed');
  assert.ok(
    warnings.some(
      (entry) =>
        entry.event === 'log_classification_failed' &&
        entry.status === 'degraded',
    ),
  );
});

test('database logs, statistical degradation and pod state form one dependency incident', async () => {
  const clusterId = 'scenario-cluster';
  const namespace = 'payments';
  const workload = 'payment-api';
  const pod = 'payment-api-7d9f-a0001';
  const now = Date.now() - 20_000;
  const at = (offset) => new Date(now + offset).toISOString();
  const baselines = new InMemoryBaselineRepository();
  const baseline = (metricName, statistics) => ({
    clusterId,
    namespace,
    workload,
    resourceType: 'workload',
    metricName,
    window: '1h',
    season: { kind: 'all' },
    status: 'READY',
    statistics: { sampleCount: 1000, ...statistics },
    sampleCount: 1000,
    windowStart: at(-3_600_000),
    windowEnd: at(0),
    excludedRanges: 0,
    updatedAt: at(0),
  });
  await baselines.save([
    baseline('faultline.workload.log_error_rate', {
      mean: 1,
      min: 0,
      max: 2,
      standardDeviation: 0.5,
      p50: 1,
      p95: 2,
      p99: 2,
    }),
    baseline('http.server.duration', {
      mean: 120,
      min: 80,
      max: 200,
      standardDeviation: 20,
      p50: 110,
      p95: 180,
      p99: 200,
    }),
  ]);
  const incidents = new InMemoryIncidentRepository();
  const classifications = new InMemoryLogClassificationRepository();
  const consumer = new TelemetryConsumer(
    new InMemoryQueue(),
    { log() {}, warn() {}, error() {}, debug() {}, verbose() {} },
    new InMemoryResourceState(),
    new InMemoryRuleEngine(createDefaultRules(), {
      memoryWarningPercent: 85,
      memoryCriticalPercent: 95,
      cpuWarningPercent: 80,
      cpuCriticalPercent: 95,
      restartThreshold: 3,
      notReadyDurationMs: 0,
      deploymentDegradationDurationMs: 0,
    }),
    new IncidentCorrelationEngine(incidents, {
      correlationWindowMs: 900_000,
      stabilizationPeriodMs: 120_000,
    }),
    undefined,
    new InMemoryStatisticalDetector(
      new CachedBaselineProvider(baselines, 60_000),
      {
        enabled: true,
        evaluationWindowMs: 900_000,
        minimumCurrentSamples: 2,
        zScoreThreshold: 3,
        zScoreResolveThreshold: 2,
        percentileRatioThreshold: 2,
        percentileRatioResolveThreshold: 1.5,
        minimumConsecutiveWindows: 1,
        resolveConsecutiveWindows: 2,
        cooldownMs: 0,
        deviationRelativeFloor: 0.05,
        growthMinimumSamples: 6,
        growthMinimumPercent: 25,
        growthMinimumRSquared: 0.7,
        growthMinimumMonotonicFraction: 0.7,
      },
    ),
    new StagedLogClassifier(classifications, settings),
  );
  const common = {
    clusterId,
    namespace,
    workload,
    service: workload,
    pod,
    node: 'node-a',
    attributes: { 'k8s.pod.uid': 'scenario-pod' },
    raw: null,
  };
  const deliver = (payload) =>
    consumer.process({ id: payload.id, payload: { ...common, ...payload } });

  for (let index = 0; index < 3; index++)
    await deliver({
      kind: 'log',
      id: `db-error-${index}`,
      timestamp: at(index * 1000),
      ingestedAt: at(index * 1000),
      level: 'error',
      message: `connection refused to PostgreSQL 10.0.0.${index + 5}:5432`,
      stream: 'stderr',
    });
  for (let index = 0; index < 3; index++)
    await deliver({
      kind: 'metric',
      id: `latency-${index}`,
      timestamp: at(4_000 + index * 1000),
      ingestedAt: at(4_000 + index * 1000),
      name: 'http.server.duration',
      value: 750,
      unit: 'ms',
      metricType: 'gauge',
    });
  await deliver({
    kind: 'metric',
    id: 'pod-not-ready',
    timestamp: at(8_000),
    ingestedAt: at(8_000),
    name: 'k8s.pod.ready',
    value: 0,
    metricType: 'gauge',
    container: undefined,
  });

  const stored = await incidents.listIncidents({ clusterId });
  assert.equal(stored.length, 1);
  const incident = stored[0];
  assert.equal(incident.classification, 'APPLICATION_DEPENDENCY_FAILURE');
  const signals = new Set(
    incident.anomalies.map((item) => item.classification),
  );
  assert.ok(signals.has('DATABASE_CONNECTIVITY'));
  assert.ok(signals.has('ERROR_RATE_ANOMALY'));
  assert.ok(signals.has('LATENCY_ANOMALY'));
  assert.ok(signals.has('POD_NOT_READY'));
  assert.ok(incident.evidence.some((item) => item.type === 'log-pattern'));
  assert.ok(incident.evidence.some((item) => item.source === 'STATISTICAL'));
  assert.ok(incident.evidence.some((item) => item.source === 'DETERMINISTIC'));
  assert.equal(
    incident.evidence.filter((item) => item.type === 'log-pattern').length,
    1,
    'repeated connection logs do not flood incident evidence',
  );
  assert.equal(incident.severity, 'HIGH');
});

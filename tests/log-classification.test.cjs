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
  normalizeLogPattern,
} = require('../apps/processor/dist/log-classification/fingerprint');
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
  scoring: {
    knownClassification: 3,
    errorSeverity: 1,
    fatalSeverity: 2,
    repeated: 2,
    frequent: 3,
    multiplePods: 2,
    repeatedOccurrenceThreshold: 5,
    frequentOccurrenceThreshold: 20,
    anomalyThreshold: 6,
    incidentThreshold: 9,
  },
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
      assert.ok(outcome.result.evidence[0].matchedSignals.length > 0);
      assert.equal(outcome.decision, 'CLASSIFICATION');
      assert.equal(outcome.anomaly, undefined);
      assert.deepEqual(
        event,
        before,
        'classification does not mutate LogEvent',
      );
    });
});

test('production runtime signatures map into the stable log taxonomy', async (t) => {
  const cases = [
    [
      'TypeError: Cannot read properties of undefined (reading id)',
      'APPLICATION_EXCEPTION',
    ],
    ['ReferenceError: customer is not defined', 'APPLICATION_EXCEPTION'],
    ['TypeError: handler is not a function', 'APPLICATION_EXCEPTION'],
    [
      'SyntaxError: Unexpected token < in JSON at position 0',
      'APPLICATION_EXCEPTION',
    ],
    [
      'UnhandledPromiseRejectionWarning: payment failed',
      'APPLICATION_EXCEPTION',
    ],
    ['RangeError: Maximum call stack size exceeded', 'APPLICATION_EXCEPTION'],
    [
      'ERR_HTTP_HEADERS_SENT: Cannot set headers after they are sent',
      'APPLICATION_EXCEPTION',
    ],
    [
      'duplicate key value violates unique constraint users_email_key',
      'APPLICATION_EXCEPTION',
    ],
    [
      'insert violates foreign key constraint orders_customer_id_fkey',
      'APPLICATION_EXCEPTION',
    ],
    ['transaction already closed', 'APPLICATION_EXCEPTION'],
    ['deadlock detected while updating orders', 'APPLICATION_EXCEPTION'],
    ['background job settlement-sync failed', 'APPLICATION_EXCEPTION'],
    ['data inconsistency after partial failure', 'APPLICATION_EXCEPTION'],
    [
      'Hydration failed because the initial UI does not match',
      'APPLICATION_EXCEPTION',
    ],
    ['ReferenceError: window is not defined', 'APPLICATION_EXCEPTION'],
    ['ChunkLoadError: Loading chunk 812 failed', 'APPLICATION_EXCEPTION'],
    ['Maximum update depth exceeded', 'APPLICATION_EXCEPTION'],
    ['password authentication failed for user app', 'DATABASE_CONNECTIVITY'],
    ['database booknest does not exist', 'DATABASE_CONNECTIVITY'],
    ['FATAL: too many connections for role app', 'DATABASE_CONNECTIVITY'],
    [
      'connection pool exhausted while acquiring client',
      'DATABASE_CONNECTIVITY',
    ],
    [
      'PrismaClientInitializationError: cannot reach database server',
      'DATABASE_CONNECTIVITY',
    ],
    ['upstream returned 502 Bad Gateway', 'DEPENDENCY_TIMEOUT'],
    ['provider service request timed out', 'DEPENDENCY_TIMEOUT'],
    ['upstream returned 504 Gateway Timeout', 'DEPENDENCY_TIMEOUT'],
    ['jwt malformed', 'AUTHENTICATION_FAILURE'],
    ['JsonWebTokenError: invalid signature', 'AUTHENTICATION_FAILURE'],
    ['Token not provided', 'AUTHENTICATION_FAILURE'],
    ['Session not found', 'AUTHENTICATION_FAILURE'],
    ['CSRF validation failed: invalid token', 'AUTHENTICATION_FAILURE'],
    ['S3 AccessDenied while reading customer export', 'AUTHORIZATION_FAILURE'],
    ['SignatureDoesNotMatch from object storage', 'AUTHORIZATION_FAILURE'],
    ['relation customer_orders does not exist', 'CONFIGURATION_ERROR'],
    ['column customer_status does not exist', 'CONFIGURATION_ERROR'],
    [
      'invalid value for environment variable PUBLIC_URL',
      'CONFIGURATION_ERROR',
    ],
    [
      'blocked by CORS policy: no access control allow origin',
      'CONFIGURATION_ERROR',
    ],
    ['EACCES: permission denied, open /data/report.pdf', 'STORAGE_FAILURE'],
    [
      'ENOENT: no such file or directory, stat /app/config.json',
      'STORAGE_FAILURE',
    ],
    ['MulterError: Unexpected field', 'STORAGE_FAILURE'],
    ['presigned URL expired; upload rejected', 'STORAGE_FAILURE'],
    ['FATAL ERROR: JavaScript heap out of memory', 'RESOURCE_EXHAUSTION'],
    ['spawn worker failed with ENOMEM', 'RESOURCE_EXHAUSTION'],
    ['worker pool exhausted under load', 'RESOURCE_EXHAUSTION'],
    ['process exited with code 137', 'RESOURCE_EXHAUSTION'],
    ['getaddrinfo ENOTFOUND api.partner.invalid', 'NETWORK_FAILURE'],
    ['socket hang up while calling payment provider', 'NETWORK_FAILURE'],
    ['TypeError: fetch failed', 'NETWORK_FAILURE'],
    ['unable to verify the first certificate', 'NETWORK_FAILURE'],
    ['Error: Cannot find module @booknest/payments', 'STARTUP_FAILURE'],
    [
      'ERR_REQUIRE_ESM: require() of ES Module not supported',
      'STARTUP_FAILURE',
    ],
    ['listen EADDRINUSE: address already in use :::3000', 'STARTUP_FAILURE'],
    ['container exits repeatedly after health check', 'STARTUP_FAILURE'],
  ];

  for (const [message, expected] of cases)
    await t.test(message, async () => {
      const outcome = await classifier().classifier.classify(log(message));
      assert.equal(outcome.result.classification, expected);
      assert.equal(outcome.result.classifierType, 'RULE');
      assert.ok(outcome.result.confidence >= 0.8);
    });
});

test('ordinary HTTP and job messages do not become production incidents', async () => {
  const messages = [
    'GET /missing returned 404',
    'request completed with status 400 after validation',
    'background job completed successfully',
    'connection pool has 8 idle connections',
    'memory usage is within the expected range',
  ];
  for (const message of messages) {
    const outcome = await classifier().classifier.classify(log(message));
    assert.equal(outcome.result.classification, 'UNKNOWN');
    assert.equal(outcome.anomaly, undefined);
  }
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
  assert.equal(outcome.decision, 'CLASSIFICATION');
  assert.equal(outcome.anomaly, undefined);
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
  const aggregate = await repository.getPattern(outcomes[0].result.patternId);
  const stored = await repository.get(outcomes[0].result.eventId);
  assert.equal(stored.classification, 'DATABASE_CONNECTIVITY');
  assert.ok(stored.evidence[0].excerpt.includes('connection refused'));
  assert.equal(aggregate.count, 3);
  assert.equal(aggregate.affectedPods.length, 3);
  assert.equal(aggregate.clusterId, 'production-eu');
  assert.equal(aggregate.namespace, 'payments');
  assert.equal(aggregate.workload, 'payment-api');
  assert.equal(aggregate.firstSeen, outcomes[0].result.timestamp);
  assert.equal(aggregate.lastSeen, outcomes[2].result.timestamp);
  assert.equal(outcomes[2].decision, 'ANOMALY');
  assert.equal(outcomes[2].anomaly.status, 'ACTIVE');
  assert.equal(outcomes[2].anomaly.evidence[0].attributes.count, 3);

  const restarted = new StagedLogClassifier(repository, settings);
  const afterRestart = await restarted.classify(
    log('connection refused 10.0.0.8:5432', {
      pod: 'payment-api-7d9f-a0003',
    }),
  );
  assert.equal(afterRestart.aggregate.count, 4);
  assert.equal(afterRestart.decision, 'ANOMALY');
  assert.equal(afterRestart.anomaly.anomalyId, outcomes[2].anomaly.anomalyId);
});

test('fingerprints normalize volatile identifiers without changing source logs', () => {
  const first =
    '2026-09-12T12:30:01.123Z request_id=abc-123 connection refused 10.0.0.4:5432 retry 2 payment-api-7d9f1234-a1b2c';
  const second =
    '2026-09-12T12:31:42.999Z request_id=xyz-987 connection refused 10.0.0.5:6432 retry 9 payment-api-8e0a5678-d3e4f';
  assert.equal(normalizeLogPattern(first), normalizeLogPattern(second));
  assert.ok(first.includes('10.0.0.4:5432'));
});

test('equivalent messages classify by semantics across language ecosystems', async () => {
  const messages = [
    'ECONNREFUSED 10.0.0.5:5432',
    'org.postgresql.util.PSQLException: Connection refused',
    'psycopg.OperationalError: connection refused',
    'dial tcp 10.0.0.5:5432: connect: connection refused',
  ];
  for (const message of messages) {
    const outcome = await classifier().classifier.classify(log(message));
    assert.equal(outcome.result.classification, 'DATABASE_CONNECTIVITY');
    assert.ok(outcome.result.confidence >= 0.8);
    assert.ok(
      outcome.result.evidence[0].matchedSignals.includes('connection refused'),
    );
  }
  assert.equal(
    (await classifier().classifier.classify(log('upstream request timed out')))
      .result.classification,
    'DEPENDENCY_TIMEOUT',
  );
  assert.equal(
    (await classifier().classifier.classify(log('permission denied'))).result
      .classification,
    'AUTHORIZATION_FAILURE',
  );
});

test('generic ERROR with no reliable semantics remains UNKNOWN', async () => {
  const outcome = await classifier().classifier.classify(
    log('ERROR something unexpected happened'),
  );
  assert.equal(outcome.result.classification, 'UNKNOWN');
  assert.equal(outcome.decision, 'CLASSIFICATION');
  assert.equal(outcome.anomaly, undefined);
});

test('incident scoring gates one error, repetition and replica-wide repetition', async () => {
  const { classifier: subject } = classifier();
  const first = await subject.classify(log('database connection refused'));
  assert.equal(first.score, 4);
  assert.equal(first.decision, 'CLASSIFICATION');
  assert.equal(first.anomaly, undefined);

  let repeated;
  for (let index = 1; index < 10; index++)
    repeated = await subject.classify(log('database connection refused'));
  assert.equal(repeated.aggregate.count, 10);
  assert.equal(repeated.score, 6);
  assert.equal(repeated.decision, 'ANOMALY');
  assert.equal(repeated.anomaly.source, 'LOG_CLASSIFIER');

  let replicaWide;
  for (let index = 10; index < 25; index++)
    replicaWide = await subject.classify(
      log('database connection refused', {
        pod: `payment-api-7d9f-a000${(index % 3) + 1}`,
      }),
    );
  assert.equal(replicaWide.aggregate.count, 25);
  assert.equal(replicaWide.aggregate.affectedPods.length, 3);
  assert.equal(replicaWide.score, 9);
  assert.equal(replicaWide.decision, 'INCIDENT');
  assert.ok(
    replicaWide.scoreReasons.some((reason) => reason.includes('pods affected')),
  );

  const incidents = new InMemoryIncidentRepository();
  const correlator = new IncidentCorrelationEngine(incidents, {
    correlationWindowMs: 600_000,
    stabilizationPeriodMs: 120_000,
  });
  assert.equal(
    await correlator.correlate(repeated.anomaly, { allowCreate: false }),
    undefined,
  );
  assert.equal((await incidents.listIncidents({})).length, 0);
  const change = await correlator.correlate(replicaWide.anomaly, {
    allowCreate: true,
  });
  assert.equal(change.type, 'CREATED');
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

test('debug tracing exposes the deterministic classification decision path', async () => {
  const traces = [];
  const subject = classifier().classifier;
  const consumer = new TelemetryConsumer(
    new InMemoryQueue(),
    {
      log() {},
      warn() {},
      error() {},
      debug(value) {
        traces.push(value);
      },
      verbose() {},
    },
    new InMemoryResourceState(),
    { evaluate: () => [] },
    undefined,
    undefined,
    { detect: async () => [] },
    subject,
  );
  await consumer.process({
    id: 'debug-classification',
    payload: log('database connection refused', {
      id: 'debug-classification',
    }),
  });
  const trace = traces.find((entry) => entry.event === 'log_classified');
  assert.equal(trace.classification, 'DATABASE_CONNECTIVITY');
  assert.equal(trace.incident_score, 4);
  assert.equal(trace.decision, 'CLASSIFICATION');
  assert.equal(trace.pattern_count, 1);
  assert.ok(trace.matched_signals.includes('connection refused'));
});

test('onboarding probes never create operational classifications or incidents', async () => {
  let evaluated = 0;
  let classified = 0;
  let correlated = 0;
  const completed = [];
  const consumer = new TelemetryConsumer(
    new InMemoryQueue(),
    { log() {}, warn() {}, error() {}, debug() {}, verbose() {} },
    new InMemoryResourceState(),
    { evaluate: () => (evaluated++, []) },
    {
      correlate: async () => (correlated++, undefined),
      advance: async () => [],
    },
    {
      begin: async () => true,
      complete: async (id) => completed.push(id),
      release: async () => {},
    },
    { detect: async () => [] },
    { classify: async () => (classified++, undefined) },
  );
  const event = log('database connection refused', {
    namespace: 'faultline-onboarding',
    workload: 'faultline-log-test',
  });
  await consumer.process({ id: event.id, payload: event });
  assert.equal(evaluated, 0);
  assert.equal(classified, 0);
  assert.equal(correlated, 0);
  assert.deepEqual(completed, [event.id]);
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

  for (let index = 0; index < 5; index++)
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

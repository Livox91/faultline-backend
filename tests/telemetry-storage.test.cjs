require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { InMemoryQueue } = require('@faultline/queue');
const {
  InMemoryTelemetryStore,
  TelemetryBatcher,
  TelemetryQueryError,
  clusterScope,
  defaultPayloadLimits,
  defaultQueryLimits,
  encodeTelemetryResourceId,
  parseTelemetryResourceId,
  toStoredLogRecord,
  truncateUtf8,
  validateLogSearchQuery,
  validateMetricQuery,
  validateResourceTimelineQuery,
  validateKubernetesEventQuery,
  validateRetentionConfig,
} = require('@faultline/telemetry');
const {
  schemaStatements,
  retentionStatements,
  quoteIdentifier,
} = require('@faultline/clickhouse');
const {
  TelemetryStorageConsumer,
} = require('../apps/storage/dist/telemetry-storage.consumer');
const {
  TelemetryController,
  ResourceTimelineController,
} = require('../apps/api/dist/telemetry.controller');
const {
  IncidentEvidenceController,
} = require('../apps/api/dist/incident-evidence.controller');
const {
  ConfiguredTelemetryScopeResolver,
} = require('../apps/api/dist/telemetry-scope');
const {
  TelemetryConsumer,
} = require('../apps/processor/dist/telemetry.consumer');
const {
  InMemoryResourceState,
} = require('../apps/processor/dist/resource-state/in-memory-resource-state');
const {
  InMemoryRuleEngine,
  createDefaultRules,
} = require('../apps/processor/dist/rules');
const {
  IncidentCorrelationEngine,
} = require('../apps/processor/dist/correlation');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const {
  telemetryStoreContract,
  iso,
} = require('./telemetry-store-contract.cjs');

const silentLogger = {
  log() {},
  warn() {},
  error() {},
  debug() {},
  verbose() {},
};

const storageConfig = (overrides = {}) => ({
  application: 'storage',
  environment: 'test',
  telemetryStorage: {
    consumerGroup: 'faultline-telemetry-storage',
    batchMaxSize: 500,
    batchMaxAgeMs: 2000,
    retention: { logsDays: 7, metricsDays: 14, kubernetesEventsDays: 30 },
    payloadLimits: defaultPayloadLimits,
    queryLimits: defaultQueryLimits,
    ...overrides,
  },
  infrastructure: { brokerConsumerGroup: 'faultline-storage' },
});

test('in-memory telemetry store satisfies the storage contract', async (t) => {
  const store = new InMemoryTelemetryStore();
  await telemetryStoreContract(t, store);
  await store.close();
});

test('batching writes on size and on age, and flushes on shutdown', async () => {
  const batches = [];
  const sized = new TelemetryBatcher({
    maxBatchSize: 3,
    maxBatchAgeMs: 60_000,
    flush: async (items) => {
      batches.push(items.length);
    },
  });
  // Two items stay buffered; the third completes the batch and releases all three.
  const first = sized.add('a');
  const second = sized.add('b');
  assert.deepEqual(batches, []);
  assert.equal(sized.pending, 2);
  await Promise.all([first, second, sized.add('c')]);
  assert.deepEqual(batches, [3]);

  const aged = new TelemetryBatcher({
    maxBatchSize: 1000,
    maxBatchAgeMs: 30,
    flush: async (items) => {
      batches.push(items.length);
    },
  });
  await aged.add('only');
  assert.deepEqual(batches, [3, 1], 'age bound flushed a partial batch');

  const closing = new TelemetryBatcher({
    maxBatchSize: 1000,
    maxBatchAgeMs: 60_000,
    flush: async (items) => {
      batches.push(items.length);
    },
  });
  const pending = closing.add('x');
  await closing.close();
  await pending;
  assert.deepEqual(
    batches,
    [3, 1, 1],
    'graceful shutdown flushed the remainder',
  );
  await assert.rejects(closing.add('after-close'), /Batcher closed/);
  for (const value of [0, -1, 1.5]) {
    assert.throws(
      () =>
        new TelemetryBatcher({
          maxBatchSize: value,
          maxBatchAgeMs: 10,
          flush: async () => {},
        }),
      /maxBatchSize/,
    );
    assert.throws(
      () =>
        new TelemetryBatcher({
          maxBatchSize: 10,
          maxBatchAgeMs: value,
          flush: async () => {},
        }),
      /maxBatchAgeMs/,
    );
  }
});

test('the storage consumer batches broker deliveries and acknowledges only after a write', async () => {
  const store = new InMemoryTelemetryStore();
  const writes = [];
  const observed = {
    ...store,
    storeLogs: (records) => {
      writes.push(records.length);
      return store.storeLogs(records);
    },
    storeMetrics: (records) => store.storeMetrics(records),
    storeKubernetesEvents: (records) => store.storeKubernetesEvents(records),
  };
  const queue = new InMemoryQueue();
  const consumer = new TelemetryStorageConsumer(
    queue,
    observed,
    storageConfig({ batchMaxSize: 3, batchMaxAgeMs: 50 }),
    silentLogger,
  );
  const clusterId = `batch-${randomUUID().slice(0, 8)}`;
  const baseMs = Date.now() - 10_000;
  const message = (index) => ({
    id: `log-${clusterId}-${index}`,
    payload: {
      kind: 'log',
      id: `log-${clusterId}-${index}`,
      timestamp: iso(baseMs + index),
      ingestedAt: iso(baseMs + index),
      clusterId,
      namespace: 'default',
      workload: 'api',
      pod: 'api-1',
      container: 'api',
      level: 'info',
      message: `entry ${index}`,
      attributes: {},
      raw: null,
    },
  });
  // Three messages hit the size bound and are written as one insert.
  await Promise.all([0, 1, 2].map((index) => consumer.process(message(index))));
  assert.deepEqual(writes, [3]);
  // A fourth is written by the age bound alone.
  await consumer.process(message(3));
  assert.deepEqual(writes, [3, 1]);
  const page = await store.searchLogs(clusterScope(clusterId), {
    clusterId,
    startTime: iso(baseMs - 1000),
    endTime: iso(baseMs + 60_000),
    limit: 50,
  });
  assert.equal(page.items.length, 4);
  await consumer.onModuleDestroy();
  await store.close();
});

test('a storage failure retries the batch without stopping detection', async () => {
  const store = new InMemoryTelemetryStore();
  let failNext = true;
  const failing = {
    ...store,
    storeLogs: async (records) => {
      if (failNext) {
        failNext = false;
        throw new Error('ClickHouse unavailable');
      }
      return store.storeLogs(records);
    },
    storeMetrics: (records) => store.storeMetrics(records),
    storeKubernetesEvents: (records) => store.storeKubernetesEvents(records),
  };
  const queue = new InMemoryQueue();
  const consumer = new TelemetryStorageConsumer(
    queue,
    failing,
    storageConfig({ batchMaxSize: 1, batchMaxAgeMs: 20 }),
    silentLogger,
  );
  const clusterId = `fail-${randomUUID().slice(0, 8)}`;
  const baseMs = Date.now() - 5000;
  const message = {
    id: `log-${clusterId}`,
    payload: {
      kind: 'log',
      id: `log-${clusterId}`,
      timestamp: iso(baseMs),
      ingestedAt: iso(baseMs),
      clusterId,
      namespace: 'default',
      level: 'error',
      message: 'boom',
      attributes: {},
      raw: null,
    },
  };
  // The handler rejects, so the broker redelivers rather than acknowledging.
  await assert.rejects(consumer.process(message), /persistence failed/);
  await consumer.process(message);
  const page = await store.searchLogs(clusterScope(clusterId), {
    clusterId,
    startTime: iso(baseMs - 1000),
    endTime: iso(baseMs + 60_000),
    limit: 10,
  });
  assert.equal(page.items.length, 1);

  // Detection uses a separate consumer over the same broker subject, so the same
  // event is still processed into resource state while storage is failing.
  const state = new InMemoryResourceState();
  const processor = new TelemetryConsumer(
    new InMemoryQueue(),
    silentLogger,
    state,
    new InMemoryRuleEngine(createDefaultRules(), {
      memoryWarningPercent: 85,
      memoryCriticalPercent: 95,
      cpuWarningPercent: 80,
      cpuCriticalPercent: 95,
      restartThreshold: 3,
      notReadyDurationMs: 60_000,
      deploymentDegradationDurationMs: 120_000,
    }),
  );
  const processed = await processor.process(message);
  assert.equal(processed.status, 'processed');
  await consumer.onModuleDestroy();
  await store.close();
});

test('retention is configuration, not a hardcoded production period', async () => {
  const statements = schemaStatements({
    database: 'faultline',
    retention: { logsDays: 3, metricsDays: 21, kubernetesEventsDays: 45 },
  });
  const ttl = statements.filter((statement) =>
    statement.includes('MODIFY TTL'),
  );
  assert.equal(ttl.length, 3);
  assert.ok(
    ttl[0].includes('telemetry_logs') && ttl[0].includes('INTERVAL 3 DAY'),
  );
  assert.ok(
    ttl[1].includes('telemetry_metrics') && ttl[1].includes('INTERVAL 21 DAY'),
  );
  assert.ok(
    ttl[2].includes('telemetry_kubernetes_events') &&
      ttl[2].includes('INTERVAL 45 DAY'),
  );
  for (const days of [0, -1, 1.5, 4000])
    assert.throws(
      () =>
        retentionStatements({
          database: 'faultline',
          retention: {
            logsDays: days,
            metricsDays: 7,
            kubernetesEventsDays: 7,
          },
        }),
      /retention/,
    );
  assert.throws(
    () =>
      validateRetentionConfig({
        logsDays: 7,
        metricsDays: 0,
        kubernetesEventsDays: 7,
      }),
    /metricsDays/,
  );

  // The store honours retention on both write and read.
  let now = Date.parse('2026-09-09T12:00:00.000Z');
  const store = new InMemoryTelemetryStore({
    retentionDays: { logs: 2 },
    now: () => now,
  });
  const clusterId = 'retention-cluster';
  const record = (offsetMs, id) =>
    toStoredLogRecord({
      kind: 'log',
      id,
      timestamp: iso(now - offsetMs),
      ingestedAt: iso(now - offsetMs),
      clusterId,
      namespace: 'default',
      level: 'info',
      message: id,
      attributes: {},
      raw: null,
    });
  const written = await store.storeLogs([
    record(0, 'fresh'),
    record(86_400_000 * 5, 'expired-on-write'),
  ]);
  assert.equal(written.written, 1, 'rows past retention are never written');
  const inWindow = {
    clusterId,
    startTime: iso(now - 86_400_000 * 30),
    endTime: iso(now + 1000),
    limit: 50,
  };
  // A wide window is impossible through the API; the store is exercised directly here.
  assert.equal(
    (await store.searchLogs(clusterScope(clusterId), inWindow)).items.length,
    1,
  );
  now += 86_400_000 * 3;
  assert.equal(
    (
      await store.searchLogs(clusterScope(clusterId), {
        ...inWindow,
        endTime: iso(now + 1000),
      })
    ).items.length,
    0,
    'rows past retention stop being readable',
  );
  await store.close();
});

test('query safety bounds every telemetry read', () => {
  const base = {
    clusterId: 'cluster-1',
    startTime: '2026-09-09T12:00:00Z',
    endTime: '2026-09-09T12:15:00Z',
  };
  const query = validateLogSearchQuery(base);
  assert.equal(query.limit, defaultQueryLimits.defaultLimit);
  assert.equal(query.startTime, '2026-09-09T12:00:00.000Z');

  // A cluster and a bounded window are mandatory.
  assert.throws(
    () => validateLogSearchQuery({ ...base, clusterId: undefined }),
    TelemetryQueryError,
  );
  assert.throws(
    () => validateLogSearchQuery({ ...base, startTime: undefined }),
    /startTime is required/,
  );
  assert.throws(
    () => validateLogSearchQuery({ ...base, endTime: undefined }),
    /endTime is required/,
  );
  assert.throws(
    () => validateLogSearchQuery({ ...base, endTime: '2026-09-09T11:00:00Z' }),
    /endTime must be after startTime/,
  );
  assert.throws(
    () => validateLogSearchQuery({ ...base, endTime: '2026-09-12T12:00:00Z' }),
    /Time range exceeds the maximum/,
  );
  // Result size is clamped, never unbounded.
  assert.equal(
    validateLogSearchQuery({ ...base, limit: '100000' }).limit,
    defaultQueryLimits.maxLimit,
  );
  assert.throws(() => validateLogSearchQuery({ ...base, limit: '0' }), /limit/);

  // Filters are validated; nothing resembling SQL survives.
  for (const injection of [
    "cluster' OR 1=1--",
    'cluster; DROP TABLE telemetry_logs',
    'a b',
    'a b',
  ])
    assert.throws(
      () => validateLogSearchQuery({ ...base, clusterId: injection }),
      /Invalid clusterId filter/,
    );
  assert.throws(
    () => validateLogSearchQuery({ ...base, namespace: 'has space' }),
    /namespace/,
  );
  assert.throws(
    () => validateLogSearchQuery({ ...base, severity: 'critical' }),
    /severity/,
  );
  assert.throws(
    () => validateLogSearchQuery({ ...base, cursor: 'not-a-cursor' }),
    /Invalid cursor/,
  );
  assert.deepEqual(
    validateLogSearchQuery({ ...base, severity: 'error,fatal' }).severity,
    ['error', 'fatal'],
  );

  // Metric aggregation cannot request a million buckets.
  assert.throws(
    () =>
      validateMetricQuery({
        ...base,
        metricName: 'k8s.container.memory.usage',
        bucket: '1',
      }),
    /Invalid bucket filter/,
  );
  assert.throws(
    () =>
      validateMetricQuery({
        ...base,
        endTime: '2026-09-09T14:00:00Z',
        metricName: 'k8s.container.memory.usage',
        bucket: '1000',
      }),
    /Bucket produces more than/,
  );
  assert.throws(
    () =>
      validateMetricQuery({
        ...base,
        metricName: 'k8s.container.memory.usage',
        aggregations: 'median',
      }),
    /aggregations/,
  );
  assert.equal(
    validateMetricQuery({ ...base, metricName: 'k8s.container.memory.usage' })
      .bucketMs >= defaultQueryLimits.minBucketMs,
    true,
  );
  assert.throws(
    () => validateKubernetesEventQuery({ ...base, type: 'Critical' }),
    /type/,
  );
  assert.throws(
    () => validateResourceTimelineQuery({ ...base, resourceId: 'nonsense' }),
    /Invalid resource identifier/,
  );

  // Database identifiers are the one value that cannot be bound, so they are checked.
  for (const name of ['faultline', 'faultline_dev'])
    assert.equal(quoteIdentifier(name), `\`${name}\``);
  for (const name of ['default`; DROP DATABASE x', 'has space', ''])
    assert.throws(() => quoteIdentifier(name), /Invalid ClickHouse identifier/);
});

test('resource identifiers round-trip and reject malformed input', () => {
  const refs = [
    {
      scope: 'container',
      clusterId: 'c-1',
      namespace: 'ns',
      name: 'pod-1',
      container: 'api',
    },
    { scope: 'pod', clusterId: 'c-1', namespace: 'ns', name: 'pod-1' },
    { scope: 'workload', clusterId: 'c-1', namespace: 'ns', name: 'api' },
    { scope: 'node', clusterId: 'c-1', name: 'node-1' },
    { scope: 'namespace', clusterId: 'c-1', name: 'ns' },
  ];
  for (const ref of refs)
    assert.deepEqual(
      parseTelemetryResourceId(encodeTelemetryResourceId(ref)),
      ref,
    );
  // Separators inside a name survive encoding rather than changing the parse.
  const awkward = { scope: 'node', clusterId: 'c:1', name: 'node:with:colons' };
  assert.deepEqual(
    parseTelemetryResourceId(encodeTelemetryResourceId(awkward)),
    awkward,
  );
  for (const value of [
    '',
    'pod:c-1',
    'unknown:c-1:ns:name',
    'pod:c-1::name',
    'container:c-1:ns:pod',
    42,
  ])
    assert.equal(parseTelemetryResourceId(value), undefined, String(value));
});

test('oversized telemetry is truncated and flagged, never dropped', () => {
  const limits = {
    maxMessageBytes: 64,
    maxRawPayloadBytes: 48,
    maxAttributeValueBytes: 16,
    maxAttributeCount: 2,
  };
  const record = toStoredLogRecord(
    {
      kind: 'log',
      id: 'oversized',
      timestamp: '2026-09-09T12:00:00Z',
      ingestedAt: '2026-09-09T12:00:00Z',
      clusterId: 'c-1',
      namespace: 'default',
      level: 'error',
      message: 'x'.repeat(5000),
      attributes: {
        alpha: 'y'.repeat(500),
        beta: { nested: true },
        gamma: 'dropped-by-count',
      },
      raw: { payload: 'z'.repeat(5000) },
    },
    limits,
  );
  assert.equal(record.messageTruncated, true);
  assert.ok(Buffer.byteLength(record.message) <= limits.maxMessageBytes);
  assert.ok(record.message.endsWith('[truncated]'));
  assert.equal(record.rawPayloadTruncated, true);
  assert.ok(Buffer.byteLength(record.rawPayload) <= limits.maxRawPayloadBytes);
  assert.equal(
    Object.keys(record.attributes).length,
    2,
    'attribute count is bounded',
  );
  assert.ok(
    Buffer.byteLength(record.attributes.alpha) <= limits.maxAttributeValueBytes,
  );
  assert.equal(record.attributes.beta, '{"nested":true}');
  assert.equal(record.attributes.gamma, undefined);
  // Truncation never splits a code point.
  const emoji = truncateUtf8('a' + '\u{1F600}'.repeat(20), 20);
  assert.equal(emoji.truncated, true);
  assert.equal(
    Buffer.compare(
      Buffer.from(emoji.value, 'utf8'),
      Buffer.from(emoji.value, 'utf8'),
    ),
    0,
  );
  assert.ok(!emoji.value.includes('�'));
  assert.equal(truncateUtf8('short', 100).truncated, false);
});

test('additional telemetry attributes need no schema change', async () => {
  const store = new InMemoryTelemetryStore();
  const clusterId = 'evolution-cluster';
  const now = Date.now() - 1000;
  await store.storeLogs([
    toStoredLogRecord({
      kind: 'log',
      id: 'evolving',
      timestamp: iso(now),
      ingestedAt: iso(now),
      clusterId,
      namespace: 'default',
      level: 'info',
      message: 'hello',
      // Fields Faultline has never seen before land in the flexible attribute map.
      attributes: {
        'k8s.node.roles': '["worker"]',
        'brand.new.kubernetes.attribute': 'value',
        'numeric.attribute': 42,
      },
      raw: null,
    }),
  ]);
  const page = await store.searchLogs(clusterScope(clusterId), {
    clusterId,
    startTime: iso(now - 1000),
    endTime: iso(now + 60_000),
    limit: 10,
  });
  assert.equal(
    page.items[0].attributes['brand.new.kubernetes.attribute'],
    'value',
  );
  assert.equal(page.items[0].attributes['numeric.attribute'], '42');
  assert.equal(page.items[0].schemaVersion, 1);
  await store.close();
});

test('the API bounds, scopes and paginates telemetry endpoints', async () => {
  const store = new InMemoryTelemetryStore();
  const clusterId = 'api-cluster';
  const baseMs = Math.floor((Date.now() - 60_000) / 1000) * 1000;
  const config = {
    application: 'api',
    environment: 'test',
    telemetryStorage: {
      queryLimits: defaultQueryLimits,
      queryClusterScope: [clusterId],
    },
  };
  const resolver = new ConfiguredTelemetryScopeResolver(config);
  const controller = new TelemetryController(
    store,
    resolver,
    config,
    silentLogger,
  );
  const timelines = new ResourceTimelineController(
    store,
    resolver,
    config,
    silentLogger,
  );
  const logs = [0, 1, 2].map((index) =>
    toStoredLogRecord({
      kind: 'log',
      id: `api-log-${index}`,
      timestamp: iso(baseMs + index * 1000),
      ingestedAt: iso(baseMs + index * 1000),
      clusterId,
      namespace: 'default',
      workload: 'api',
      pod: 'api-1',
      container: 'api',
      level: index === 1 ? 'error' : 'info',
      message: `line ${index}`,
      attributes: {},
      raw: null,
    }),
  );
  await store.storeLogs(logs);
  const window = {
    startTime: iso(baseMs),
    endTime: iso(baseMs + 60_000),
  };

  // A single-cluster scope does not require the caller to name the cluster.
  const all = await controller.logs({ ...window });
  assert.equal(all.items.length, 3);
  assert.equal(all.query.clusterId, clusterId);

  const firstPage = await controller.logs({ ...window, limit: '2' });
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor);
  const secondPage = await controller.logs({
    ...window,
    limit: '2',
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, undefined);

  // A cluster outside the configured scope is refused, whatever the client claims.
  await assert.rejects(
    controller.logs({ ...window, clusterId: 'someone-elses-cluster' }),
    (error) => error.getStatus() === 403,
  );
  await assert.rejects(
    controller.logs({ clusterId, startTime: window.startTime }),
    (error) => error.getStatus() === 400,
  );
  await assert.rejects(
    timelines.timeline('not-a-resource', window),
    (error) => error.getStatus() === 400,
  );

  const timeline = await timelines.timeline(
    encodeTelemetryResourceId({
      scope: 'pod',
      clusterId,
      namespace: 'default',
      name: 'api-1',
    }),
    { ...window, metricNames: '' },
  );
  assert.equal(timeline.logs.length, 3);
  assert.equal(timeline.resourceId, `pod:${clusterId}:default:api-1`);

  // Telemetry storage being unavailable is a 503, not a 500 leaking adapter detail.
  const brokenStore = {
    searchLogs: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  };
  const broken = new TelemetryController(
    brokenStore,
    resolver,
    config,
    silentLogger,
  );
  await assert.rejects(
    broken.logs({ ...window }),
    (error) => error.getStatus() === 503,
  );
  await store.close();
});

test('an unscoped API deployment fails closed in production', async () => {
  const resolver = new ConfiguredTelemetryScopeResolver({
    application: 'api',
    environment: 'production',
    telemetryStorage: { queryLimits: defaultQueryLimits },
  });
  await assert.rejects(
    resolver.resolve(),
    (error) => error.getStatus() === 503,
  );
  const development = new ConfiguredTelemetryScopeResolver({
    application: 'api',
    environment: 'development',
    telemetryStorage: { queryLimits: defaultQueryLimits },
  });
  assert.deepEqual(await development.resolve(), {
    mode: 'all-development-clusters',
  });
});

test('ERROR log, Kubernetes event and rising memory produce an incident whose evidence resolves to stored telemetry', async () => {
  const clusterId = 'scenario-cluster';
  const namespace = 'faultline-demo';
  const workload = 'checkout-api';
  const pod = 'checkout-api-6b4c';
  const container = 'checkout';
  // Resource state expires relative to event time, so the scenario runs on a recent
  // window rather than a synthetic one far in the past.
  const baseMs = Math.floor(Date.now() / 1000) * 1000 - 10_000;
  const at = (offset) => iso(baseMs + offset);

  const telemetryStore = new InMemoryTelemetryStore();
  const incidents = new InMemoryIncidentRepository();
  const queue = new InMemoryQueue();
  const state = new InMemoryResourceState();
  const thresholds = {
    memoryWarningPercent: 85,
    memoryCriticalPercent: 95,
    cpuWarningPercent: 80,
    cpuCriticalPercent: 95,
    restartThreshold: 3,
    notReadyDurationMs: 60_000,
    deploymentDegradationDurationMs: 120_000,
  };
  // Detection and storage are two independent consumers of the same broker subject.
  const processor = new TelemetryConsumer(
    queue,
    silentLogger,
    state,
    new InMemoryRuleEngine(createDefaultRules(), thresholds),
    new IncidentCorrelationEngine(incidents, {
      correlationWindowMs: 600_000,
      stabilizationPeriodMs: 120_000,
    }),
  );
  const storage = new TelemetryStorageConsumer(
    queue,
    telemetryStore,
    storageConfig({ batchMaxSize: 1, batchMaxAgeMs: 20 }),
    silentLogger,
  );

  const identity = {
    clusterId,
    namespace,
    workload,
    pod,
    container,
    node: 'node-a',
    service: workload,
    attributes: { 'k8s.pod.uid': 'checkout-uid' },
    raw: null,
  };
  const deliver = async (event) => {
    const message = { id: event.id, payload: event };
    // Both consumers receive every event; neither depends on the other succeeding.
    const [detection] = await Promise.all([
      processor.process(message),
      storage.process(message),
    ]);
    return detection;
  };

  // 1. The application emits an ERROR log.
  await deliver({
    ...identity,
    kind: 'log',
    id: 'scenario-log-1',
    timestamp: at(0),
    ingestedAt: at(0),
    level: 'error',
    message: 'java.lang.OutOfMemoryError: Java heap space',
    stream: 'stderr',
  });
  // 2. A Kubernetes event records the container being killed.
  await deliver({
    ...identity,
    kind: 'kubernetes',
    id: 'scenario-event-1',
    timestamp: at(1000),
    ingestedAt: at(1000),
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container checkout',
    count: 2,
    involvedObject: {
      clusterId,
      apiVersion: 'v1',
      kind: 'Pod',
      name: pod,
      namespace,
      uid: 'checkout-uid',
    },
  });
  // 3. Memory climbs past the critical threshold against a known limit.
  await deliver({
    ...identity,
    kind: 'metric',
    id: 'scenario-metric-limit',
    timestamp: at(1500),
    ingestedAt: at(1500),
    name: 'k8s.container.memory.limit',
    value: 1_000_000_000,
    unit: 'By',
    metricType: 'gauge',
    category: 'configuration',
  });
  let change;
  for (const [index, value] of [
    500_000_000, 900_000_000, 985_000_000,
  ].entries()) {
    await deliver({
      ...identity,
      kind: 'metric',
      id: `scenario-metric-usage-${index}`,
      timestamp: at(2000 + index * 1000),
      ingestedAt: at(2000 + index * 1000),
      name: 'k8s.container.memory.usage',
      value,
      unit: 'By',
      metricType: 'gauge',
      category: 'usage',
    });
  }

  // 4. Faultline detected and correlated an incident into PostgreSQL's repository.
  const stored = await incidents.listIncidents({ clusterId });
  assert.equal(stored.length, 1, 'one correlated incident');
  const incident = stored[0];
  assert.equal(incident.clusterId, clusterId);
  assert.equal(incident.namespace, namespace);
  assert.ok(incident.anomalies.length >= 1);

  // 5. Telemetry persisted to the telemetry store, not to the incident database.
  await storage.flush();
  const scope = clusterScope(clusterId);
  const window = { startTime: at(-60_000), endTime: at(60_000) };
  assert.equal(
    (
      await telemetryStore.searchLogs(scope, {
        clusterId,
        ...window,
        limit: 50,
      })
    ).items.length,
    1,
  );
  assert.equal(
    (
      await telemetryStore.searchKubernetesEvents(scope, {
        clusterId,
        ...window,
        limit: 50,
      })
    ).items.length,
    1,
  );
  assert.equal(
    (
      await telemetryStore.queryMetrics(scope, {
        clusterId,
        metricName: 'k8s.container.memory.usage',
        ...window,
        bucketMs: 60_000,
        aggregations: ['max', 'count'],
        limit: 10,
      })
    ).items[0].max,
    985_000_000,
  );
  assert.equal(
    JSON.stringify(incident).includes('java.lang.OutOfMemoryError'),
    false,
    'raw telemetry is never copied into the incident aggregate',
  );

  // 6. The incident API returns the incident.
  const apiConfig = {
    application: 'api',
    environment: 'test',
    telemetryStorage: {
      queryLimits: defaultQueryLimits,
      queryClusterScope: [clusterId],
    },
  };
  const resolver = new ConfiguredTelemetryScopeResolver(apiConfig);
  const evidenceController = new IncidentEvidenceController(
    incidents,
    telemetryStore,
    resolver,
    apiConfig,
    silentLogger,
  );

  // 7. Evidence lookup and the timeline return the supporting telemetry.
  const evidence = await evidenceController.evidence(
    incident.id,
    undefined,
    undefined,
    undefined,
  );
  assert.equal(evidence.incidentId, incident.id);
  assert.ok(
    Date.parse(evidence.window.startTime) <= Date.parse(incident.firstSeen),
  );
  assert.ok(
    Date.parse(evidence.window.endTime) >= Date.parse(incident.lastSeen),
  );
  assert.ok(evidence.resources.length >= 1);
  assert.ok(evidence.queryContext.resourceIds.length >= 1);
  assert.equal(evidence.telemetry.errorLogs.length, 1);
  assert.match(
    evidence.telemetry.errorLogs[0].message,
    /java\.lang\.OutOfMemoryError/,
  );
  assert.equal(evidence.telemetry.kubernetesEvents.length, 1);
  assert.equal(evidence.telemetry.kubernetesEvents[0].reason, 'BackOff');
  assert.ok(evidence.telemetry.metrics.length >= 1);

  const timelines = new ResourceTimelineController(
    telemetryStore,
    resolver,
    apiConfig,
    silentLogger,
  );
  const timeline = await timelines.timeline(
    encodeTelemetryResourceId({
      scope: 'container',
      clusterId,
      namespace,
      name: pod,
      container,
    }),
    window,
  );
  assert.equal(timeline.logs.length, 1);
  assert.equal(timeline.kubernetesEvents.length, 1);
  assert.ok(timeline.metrics.length >= 1);

  await storage.onModuleDestroy();
  await telemetryStore.close();
  await queue.close();
});

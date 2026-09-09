// Shared TelemetryStore contract. The in-memory adapter and the ClickHouse adapter must
// behave identically here, so development, tests and production agree on query
// semantics: scope enforcement, filtering, ordering, pagination and deduplication.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  clusterScope,
  encodeTelemetryResourceId,
  toStoredKubernetesEventRecord,
  toStoredLogRecord,
  toStoredMetricRecord,
} = require('@faultline/telemetry');

const iso = (ms) => new Date(ms).toISOString();

/** Deterministic, self-contained telemetry for one synthetic cluster. */
function buildFixtures(clusterId, baseMs) {
  const common = {
    clusterId,
    namespace: 'payments',
    workload: 'payment-api',
    pod: 'payment-api-7d9f',
    container: 'api',
    node: 'node-1',
    service: 'payment-api',
    ingestedAt: iso(baseMs),
    attributes: {},
    raw: null,
  };
  const logs = [
    { level: 'info', message: 'Payment accepted', stream: 'stdout', offset: 0 },
    {
      level: 'warn',
      message: 'Retrying downstream call',
      stream: 'stdout',
      offset: 1000,
    },
    {
      level: 'error',
      message: 'OutOfMemoryError while allocating buffer',
      stream: 'stderr',
      offset: 2000,
    },
    {
      level: 'error',
      message: 'Connection reset by peer',
      stream: 'stderr',
      offset: 3000,
    },
    { level: 'info', message: 'Shutting down', stream: 'stdout', offset: 4000 },
  ].map((entry, index) =>
    toStoredLogRecord({
      ...common,
      kind: 'log',
      id: `log-${clusterId}-${index}`,
      timestamp: iso(baseMs + entry.offset),
      level: entry.level,
      message: entry.message,
      stream: entry.stream,
      attributes: { 'k8s.pod.uid': 'pod-uid-1', trace_id: `trace-${index}` },
      raw: { original: entry.message },
    }),
  );
  // Two samples per 10s bucket so aggregation has something to collapse.
  const metrics = [
    { offset: 0, value: 100 },
    { offset: 4000, value: 300 },
    { offset: 10_000, value: 700 },
    { offset: 14_000, value: 900 },
  ].map((sample, index) =>
    toStoredMetricRecord({
      ...common,
      kind: 'metric',
      id: `metric-${clusterId}-${index}`,
      timestamp: iso(baseMs + sample.offset),
      name: 'k8s.container.memory.usage',
      value: sample.value,
      unit: 'By',
      metricType: 'gauge',
      category: 'usage',
    }),
  );
  const events = [
    {
      reason: 'BackOff',
      type: 'Warning',
      message: 'Back-off restarting failed container',
      offset: 1500,
    },
    {
      reason: 'Unhealthy',
      type: 'Warning',
      message: 'Liveness probe failed',
      offset: 2500,
    },
    {
      reason: 'FailedScheduling',
      type: 'Warning',
      message: 'Insufficient memory',
      offset: 3500,
    },
  ].map((entry, index) =>
    toStoredKubernetesEventRecord({
      ...common,
      kind: 'kubernetes',
      id: `event-${clusterId}-${index}`,
      timestamp: iso(baseMs + entry.offset),
      reason: entry.reason,
      type: entry.type,
      message: entry.message,
      count: index + 1,
      involvedObject: {
        clusterId,
        apiVersion: 'v1',
        kind: 'Pod',
        name: common.pod,
        namespace: common.namespace,
        uid: 'pod-uid-1',
      },
    }),
  );
  return { logs, metrics, events };
}

/**
 * Runs the full contract against one adapter.
 *
 * `createStore` returns `{ store }`; the caller owns setup and teardown so the
 * ClickHouse variant can point at a real server while the in-memory variant does not.
 */
async function telemetryStoreContract(t, store) {
  const clusterId = `contract-${randomUUID().slice(0, 8)}`;
  const otherClusterId = `other-${randomUUID().slice(0, 8)}`;
  // Aligned to a whole second so metric bucket boundaries are exact.
  const baseMs = Math.floor((Date.now() - 60_000) / 1000) * 1000;
  const scope = clusterScope(clusterId);
  const window = { startTime: iso(baseMs), endTime: iso(baseMs + 60_000) };
  const { logs, metrics, events } = buildFixtures(clusterId, baseMs);
  const foreign = buildFixtures(otherClusterId, baseMs);

  await t.test(
    'log persistence preserves message and Kubernetes metadata',
    async () => {
      assert.equal((await store.storeLogs(logs)).written, logs.length);
      assert.equal(
        (await store.storeLogs(foreign.logs)).written,
        foreign.logs.length,
      );
      const page = await store.searchLogs(scope, {
        clusterId,
        ...window,
        limit: 50,
      });
      assert.equal(page.items.length, logs.length);
      const error = page.items.find(
        (item) => item.message === 'OutOfMemoryError while allocating buffer',
      );
      assert.ok(error, 'original log message is preserved verbatim');
      assert.equal(error.severity, 'error');
      assert.equal(error.stream, 'stderr');
      assert.equal(error.namespace, 'payments');
      assert.equal(error.workload, 'payment-api');
      assert.equal(error.pod, 'payment-api-7d9f');
      assert.equal(error.container, 'api');
      assert.equal(error.node, 'node-1');
      assert.equal(error.attributes['k8s.pod.uid'], 'pod-uid-1');
      assert.equal(error.traceId, 'trace-2');
      assert.match(error.rawPayload, /OutOfMemoryError/);
      assert.equal(error.messageTruncated, false);
      // Newest first.
      assert.equal(page.items[0].message, 'Shutting down');
    },
  );

  await t.test(
    'metric persistence keeps one table for every metric name',
    async () => {
      assert.equal((await store.storeMetrics(metrics)).written, metrics.length);
      await store.storeMetrics(foreign.metrics);
      const page = await store.queryMetrics(scope, {
        clusterId,
        metricName: 'k8s.container.memory.usage',
        ...window,
        bucketMs: 60_000,
        aggregations: ['count'],
        limit: 10,
      });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0].count, metrics.length);
      assert.equal(page.items[0].metricName, 'k8s.container.memory.usage');
      assert.equal(page.items[0].unit, 'By');
      assert.equal(page.items[0].container, 'api');
    },
  );

  await t.test(
    'Kubernetes events are queryable alongside logs and metrics',
    async () => {
      assert.equal(
        (await store.storeKubernetesEvents(events)).written,
        events.length,
      );
      await store.storeKubernetesEvents(foreign.events);
      const all = await store.searchKubernetesEvents(scope, {
        clusterId,
        ...window,
        limit: 50,
      });
      assert.deepEqual(all.items.map((item) => item.reason).sort(), [
        'BackOff',
        'FailedScheduling',
        'Unhealthy',
      ]);
      const backOff = await store.searchKubernetesEvents(scope, {
        clusterId,
        reason: 'BackOff',
        ...window,
        limit: 50,
      });
      assert.equal(backOff.items.length, 1);
      assert.equal(backOff.items[0].resourceKind, 'Pod');
      assert.equal(backOff.items[0].resourceName, 'payment-api-7d9f');
      assert.equal(backOff.items[0].resourceUid, 'pod-uid-1');
      assert.equal(backOff.items[0].count, 1);
      assert.equal(backOff.items[0].type, 'Warning');
      const warnings = await store.searchKubernetesEvents(scope, {
        clusterId,
        type: 'Warning',
        pod: 'payment-api-7d9f',
        ...window,
        limit: 50,
      });
      assert.equal(warnings.items.length, 3);
    },
  );

  await t.test(
    'log filters narrow by identity, severity and message text',
    async () => {
      const errors = await store.searchLogs(scope, {
        clusterId,
        severity: ['error', 'fatal'],
        ...window,
        limit: 50,
      });
      assert.equal(errors.items.length, 2);
      const search = await store.searchLogs(scope, {
        clusterId,
        search: 'outofmemory',
        ...window,
        limit: 50,
      });
      assert.equal(search.items.length, 1);
      assert.match(search.items[0].message, /OutOfMemoryError/);
      const scoped = await store.searchLogs(scope, {
        clusterId,
        namespace: 'payments',
        workload: 'payment-api',
        pod: 'payment-api-7d9f',
        container: 'api',
        ...window,
        limit: 50,
      });
      assert.equal(scoped.items.length, 5);
      for (const filter of [
        { namespace: 'other' },
        { workload: 'other' },
        { pod: 'other' },
        { container: 'other' },
        { node: 'other' },
        { traceId: 'missing' },
      ]) {
        const empty = await store.searchLogs(scope, {
          clusterId,
          ...filter,
          ...window,
          limit: 50,
        });
        assert.equal(empty.items.length, 0, JSON.stringify(filter));
      }
    },
  );

  await t.test(
    'time-range queries include the start and exclude the end',
    async () => {
      const early = await store.searchLogs(scope, {
        clusterId,
        startTime: iso(baseMs),
        endTime: iso(baseMs + 2000),
        limit: 50,
      });
      assert.deepEqual(
        early.items.map((item) => item.message),
        ['Retrying downstream call', 'Payment accepted'],
      );
      const outside = await store.searchLogs(scope, {
        clusterId,
        startTime: iso(baseMs + 30_000),
        endTime: iso(baseMs + 60_000),
        limit: 50,
      });
      assert.equal(outside.items.length, 0);
    },
  );

  await t.test(
    'metric aggregation buckets min, max, avg and count',
    async () => {
      const page = await store.queryMetrics(scope, {
        clusterId,
        metricName: 'k8s.container.memory.usage',
        container: 'api',
        ...window,
        bucketMs: 10_000,
        aggregations: ['min', 'max', 'avg', 'count'],
        limit: 100,
      });
      assert.equal(page.items.length, 2);
      assert.equal(page.items[0].bucketStart, iso(baseMs));
      assert.deepEqual(
        [
          page.items[0].min,
          page.items[0].max,
          page.items[0].avg,
          page.items[0].count,
        ],
        [100, 300, 200, 2],
      );
      assert.equal(page.items[1].bucketStart, iso(baseMs + 10_000));
      assert.deepEqual(
        [
          page.items[1].min,
          page.items[1].max,
          page.items[1].avg,
          page.items[1].count,
        ],
        [700, 900, 800, 2],
      );
      const subset = await store.queryMetrics(scope, {
        clusterId,
        metricName: 'k8s.container.memory.usage',
        ...window,
        bucketMs: 60_000,
        aggregations: ['max'],
        limit: 100,
      });
      assert.equal(subset.items[0].max, 900);
      assert.equal(subset.items[0].min, undefined);
      assert.equal(subset.items[0].avg, undefined);
    },
  );

  await t.test(
    'resource timeline answers "what happened to this workload"',
    async () => {
      const resource = {
        scope: 'container',
        clusterId,
        namespace: 'payments',
        name: 'payment-api-7d9f',
        container: 'api',
      };
      const timeline = await store.getResourceTimeline(scope, {
        resource,
        ...window,
        limit: 50,
        metricNames: ['k8s.container.memory.usage'],
      });
      assert.equal(timeline.logs.length, 5);
      // Kubernetes events attach to the pod, not the container inside it.
      assert.equal(timeline.kubernetesEvents.length, 3);
      assert.equal(timeline.metrics.length, 4);
      assert.deepEqual(timeline.window, window);
      assert.deepEqual(timeline.truncated, {
        logs: false,
        kubernetesEvents: false,
        metrics: false,
      });
      assert.equal(
        encodeTelemetryResourceId(timeline.resource),
        `container:${clusterId}:payments:payment-api-7d9f:api`,
      );
      const narrowed = await store.getResourceTimeline(scope, {
        resource,
        ...window,
        limit: 1,
        severity: ['error'],
        metricNames: [],
      });
      assert.equal(narrowed.logs.length, 1);
      assert.equal(narrowed.metrics.length, 0);
      assert.equal(narrowed.truncated.logs, true);
    },
  );

  await t.test(
    'pagination walks the whole result set exactly once',
    async () => {
      const seen = [];
      let cursor;
      for (let request = 0; request < 10; request++) {
        const page = await store.searchLogs(scope, {
          clusterId,
          ...window,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((item) => item.eventId));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      assert.equal(cursor, undefined, 'pagination terminates');
      assert.equal(seen.length, logs.length);
      assert.equal(
        new Set(seen).size,
        logs.length,
        'no duplicates across pages',
      );
    },
  );

  await t.test('a redelivered event ID stores one row, not two', async () => {
    const duplicate = {
      ...logs[2],
      message: 'OutOfMemoryError while allocating buffer (redelivered)',
    };
    await store.storeLogs([duplicate]);
    const page = await store.searchLogs(scope, {
      clusterId,
      severity: ['error'],
      ...window,
      limit: 50,
    });
    const matching = page.items.filter(
      (item) => item.eventId === logs[2].eventId,
    );
    assert.equal(matching.length, 1);
    assert.equal(page.items.length, 2);
  });

  await t.test(
    'queries cannot reach a cluster outside the authorized scope',
    async () => {
      const foreignScope = clusterScope(otherClusterId);
      await assert.rejects(
        store.searchLogs(foreignScope, { clusterId, ...window, limit: 10 }),
        /authorized telemetry scope/,
      );
      await assert.rejects(
        store.searchKubernetesEvents(foreignScope, {
          clusterId,
          ...window,
          limit: 10,
        }),
        /authorized telemetry scope/,
      );
      await assert.rejects(
        store.queryMetrics(foreignScope, {
          clusterId,
          metricName: 'k8s.container.memory.usage',
          ...window,
          bucketMs: 10_000,
          aggregations: ['avg'],
          limit: 10,
        }),
        /authorized telemetry scope/,
      );
      await assert.rejects(
        store.getResourceTimeline(foreignScope, {
          resource: {
            scope: 'pod',
            clusterId,
            namespace: 'payments',
            name: 'payment-api-7d9f',
          },
          ...window,
          limit: 10,
        }),
        /authorized telemetry scope/,
      );
      // The other cluster's identical fixtures stay invisible to this cluster's scope.
      const own = await store.searchLogs(scope, {
        clusterId,
        ...window,
        limit: 50,
      });
      assert.ok(own.items.every((item) => item.clusterId === clusterId));
    },
  );
}

module.exports = { telemetryStoreContract, buildFixtures, iso };

// ClickHouse integration tests. They exercise the same TelemetryStore contract the
// in-memory adapter passes, against a real server, plus the parts that only exist in
// ClickHouse: the applied schema, native TTL retention, and server-side query limits.
//
//   npm run infra:up
//   $env:CLICKHOUSE_URL = "http://127.0.0.1:8123"
//   $env:CLICKHOUSE_USERNAME = "faultline"; $env:CLICKHOUSE_PASSWORD = "<secret>"
//   $env:RUN_CLICKHOUSE_TESTS = "true"
//   npm run test:clickhouse
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  ClickHouseConnection,
  ClickHouseTelemetryStore,
} = require('@faultline/clickhouse');
const {
  TelemetryBatcher,
  clusterScope,
  toStoredLogRecord,
} = require('@faultline/telemetry');
const {
  telemetryStoreContract,
  iso,
} = require('./telemetry-store-contract.cjs');

const enabled = process.env.RUN_CLICKHOUSE_TESTS === 'true';
const url = process.env.CLICKHOUSE_URL;
// A dedicated database keeps integration runs away from development telemetry.
const database = process.env.CLICKHOUSE_TEST_DATABASE ?? 'faultline_test';

const retention = { logsDays: 3, metricsDays: 9, kubernetesEventsDays: 21 };

function connect(overrides = {}) {
  return new ClickHouseConnection({
    url,
    database,
    ...(process.env.CLICKHOUSE_USERNAME
      ? { username: process.env.CLICKHOUSE_USERNAME }
      : {}),
    ...(process.env.CLICKHOUSE_PASSWORD
      ? { password: process.env.CLICKHOUSE_PASSWORD }
      : {}),
    retention,
    ...overrides,
  });
}

test(
  'ClickHouse telemetry storage integration',
  {
    skip:
      !enabled || !url
        ? 'Set RUN_CLICKHOUSE_TESTS=true and CLICKHOUSE_URL'
        : false,
    timeout: 120_000,
  },
  async (t) => {
    const connection = connect();
    await connection.applySchema();
    // Applying twice must be safe: it is a deployment step, not a one-shot migration.
    await connection.applySchema();
    const store = new ClickHouseTelemetryStore(connection);

    await t.test('readiness fails until the schema is applied', async () => {
      await connection.ping();
      const missing = connect({
        database: `faultline_absent_${randomUUID().slice(0, 8)}`,
      });
      await assert.rejects(missing.ping(), /schema has not been applied/);
      await missing.close();
    });

    await t.test(
      'tables are ordered and partitioned for Faultline query patterns',
      async () => {
        const rows = await connection.client
          .query({
            query: `SELECT name, sorting_key, partition_key, engine FROM system.tables
                  WHERE database = {database:String} AND name LIKE 'telemetry_%'
                  ORDER BY name`,
            query_params: { database },
            format: 'JSONEachRow',
          })
          .then((result) => result.json());
        assert.equal(rows.length, 3);
        for (const row of rows) {
          assert.equal(row.engine, 'ReplacingMergeTree');
          assert.equal(row.partition_key, 'toDate(event_timestamp)');
          assert.match(row.sorting_key, /^cluster_id/);
          // A unique sort key is what lets ReplacingMergeTree collapse a redelivery.
          assert.match(row.sorting_key, /event_id$/);
        }
      },
    );

    await telemetryStoreContract(t, store);

    await t.test(
      'retention is applied as a native TTL from configuration',
      async () => {
        const rows = await connection.client
          .query({
            query: `SELECT name, engine_full FROM system.tables
                  WHERE database = {database:String} AND name LIKE 'telemetry_%'
                  ORDER BY name`,
            query_params: { database },
            format: 'JSONEachRow',
          })
          .then((result) => result.json());
        const ttl = Object.fromEntries(
          rows.map((row) => [row.name, row.engine_full]),
        );
        assert.match(ttl.telemetry_logs, /TTL .*INTERVAL 3 DAY/);
        assert.match(ttl.telemetry_metrics, /TTL .*INTERVAL 9 DAY/);
        assert.match(ttl.telemetry_kubernetes_events, /TTL .*INTERVAL 21 DAY/);

        // Changing configuration reconciles the TTL without a hand-written migration.
        const relaxed = connect({
          retention: { logsDays: 11, metricsDays: 9, kubernetesEventsDays: 21 },
        });
        await relaxed.applyRetention();
        const updated = await connection.client
          .query({
            query: `SELECT engine_full FROM system.tables
                  WHERE database = {database:String} AND name = 'telemetry_logs'`,
            query_params: { database },
            format: 'JSONEachRow',
          })
          .then((result) => result.json());
        assert.match(updated[0].engine_full, /TTL .*INTERVAL 11 DAY/);
        await relaxed.close();
        // Restore the configured value so later assertions see the declared retention.
        await connection.applyRetention();
      },
    );

    await t.test(
      'batched inserts reach ClickHouse as whole batches',
      async () => {
        const clusterId = `batched-${randomUUID().slice(0, 8)}`;
        const baseMs = Math.floor(Date.now() / 1000) * 1000 - 60_000;
        const inserts = [];
        const batcher = new TelemetryBatcher({
          maxBatchSize: 50,
          maxBatchAgeMs: 5_000,
          flush: async (records) => {
            inserts.push(records.length);
            await store.storeLogs(records);
          },
        });
        const total = 120;
        await Promise.all(
          Array.from({ length: total }, (_unused, index) =>
            batcher.add(
              toStoredLogRecord({
                kind: 'log',
                id: `batched-${clusterId}-${index}`,
                timestamp: iso(baseMs + index),
                ingestedAt: iso(baseMs + index),
                clusterId,
                namespace: 'default',
                workload: 'api',
                pod: 'api-1',
                container: 'api',
                level: 'info',
                message: `batched entry ${index}`,
                attributes: {},
                raw: null,
              }),
            ),
          ),
        );
        await batcher.close();
        // 120 records at a maximum batch of 50: never one insert per row.
        assert.deepEqual(inserts, [50, 50, 20]);
        const page = await store.searchLogs(clusterScope(clusterId), {
          clusterId,
          startTime: iso(baseMs - 1000),
          endTime: iso(baseMs + 600_000),
          limit: 500,
        });
        assert.equal(page.items.length, total);
      },
    );

    await t.test(
      'server-side limits reject a query that would run too long',
      async () => {
        const impatient = new ClickHouseTelemetryStore(connection, {
          queryLimits: {
            maxTimeRangeMs: 86_400_000,
            maxMetricTimeRangeMs: 604_800_000,
            maxLimit: 500,
            defaultLimit: 100,
            // Below ClickHouse's one-second granularity, so the ceiling always trips.
            queryTimeoutMs: 1,
            minBucketMs: 1000,
            maxBuckets: 1000,
          },
        });
        const clusterId = `timeout-${randomUUID().slice(0, 8)}`;
        await assert.rejects(
          impatient.searchLogs(clusterScope(clusterId), {
            clusterId,
            startTime: iso(Date.now() - 3_600_000),
            endTime: iso(Date.now()),
            limit: 10,
          }),
        );
      },
    );

    await t.test(
      'development truncation clears telemetry without dropping the schema',
      async () => {
        await connection.truncateTelemetry();
        const rows = await connection.client
          .query({
            query: `SELECT count() AS total FROM ${'`' + database + '`'}.telemetry_logs`,
            format: 'JSONEachRow',
          })
          .then((result) => result.json());
        assert.equal(Number(rows[0].total), 0);
        await connection.ping();
      },
    );

    await connection.close();
  },
);

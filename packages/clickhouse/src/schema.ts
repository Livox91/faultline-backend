import type { TelemetryRetentionConfig } from '@faultline/telemetry';

/**
 * ClickHouse telemetry schema.
 *
 * Table design follows the queries Faultline actually issues, in rough order of
 * frequency:
 *
 *   1. logs for a workload over a time window
 *   2. errors for a cluster during an incident window
 *   3. Kubernetes events for a specific pod
 *   4. memory/CPU metrics for a container over time
 *   5. everything around an incident window
 *
 * Every one of those names a cluster first, then narrows by namespace and workload,
 * then bounds time. So each table sorts by `(cluster_id, namespace, ...identity...,
 * event_timestamp, event_id)`. Putting `cluster_id` first also makes multi-tenant
 * isolation a prefix scan rather than a filter over the whole table, and the trailing
 * `event_id` makes the sort key unique so `ReplacingMergeTree` collapses a redelivered
 * event instead of storing it twice.
 *
 * Partitioning is by day (`toDate(event_timestamp)`). Days match both the query windows
 * the API allows and the retention TTL, so expiry drops whole partitions and a bounded
 * query touches a bounded number of them. Finer partitioning (hour) would multiply part
 * counts for no gain at this volume; coarser (month) would make TTL rewrite large parts.
 *
 * Data-skipping indexes are deliberately few: a token bloom filter over
 * `lowerUTF8(message)` for message search, bloom filters on the identifiers that appear
 * in queries but sit late in the sort key (pod, resource_name, trace_id, event_id), and a
 * `set` index on event reason. Anything more is premature until real query profiles
 * justify it.
 *
 * The message index is indexed on the same expression the query filters on, because a
 * `tokenbf_v1` index only applies to `LIKE`-family predicates over its exact expression:
 * searching with `position(...)` would silently read every granule instead.
 *
 * Schema evolution: important searchable fields are real columns; everything else lives
 * in `attributes Map(String, String)`. A new Kubernetes attribute therefore needs no
 * migration, and `schema_version` records which mapping produced a row.
 */

export interface SchemaOptions {
  database: string;
  retention: TelemetryRetentionConfig;
}

/** Columns shared by all three telemetry tables. */
const identityColumns = `
  cluster_id LowCardinality(String),
  namespace LowCardinality(String),
  workload LowCardinality(String),
  pod String,
  container LowCardinality(String),
  node LowCardinality(String),
  service LowCardinality(String)`;

const provenanceColumns = `
  event_id String,
  ingested_at DateTime64(3, 'UTC'),
  processed_at DateTime64(3, 'UTC'),
  attributes Map(String, String),
  schema_version UInt16`;

export const telemetryTables = [
  'telemetry_logs',
  'telemetry_metrics',
  'telemetry_kubernetes_events',
] as const;

export type TelemetryTable = (typeof telemetryTables)[number];

export function createDatabaseStatement(database: string): string {
  return `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}`;
}

/**
 * `CREATE TABLE IF NOT EXISTS` plus an unconditional `MODIFY TTL`, so changing a
 * retention setting is a restart rather than a hand-written migration.
 */
export function schemaStatements(options: SchemaOptions): string[] {
  const db = quoteIdentifier(options.database);
  return [
    `CREATE TABLE IF NOT EXISTS ${db}.telemetry_logs (
  event_timestamp DateTime64(3, 'UTC'),${identityColumns},
  severity LowCardinality(String),
  stream LowCardinality(String),
  message String,
  message_truncated UInt8,
  trace_id String,
  request_id String,
  raw_payload String,
  raw_payload_truncated UInt8,${provenanceColumns},
  INDEX idx_logs_message lowerUTF8(message) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
  INDEX idx_logs_pod pod TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX idx_logs_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX idx_logs_event_id event_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toDate(event_timestamp)
ORDER BY (cluster_id, namespace, workload, severity, event_timestamp, event_id)
SETTINGS index_granularity = 8192`,

    `CREATE TABLE IF NOT EXISTS ${db}.telemetry_metrics (
  event_timestamp DateTime64(3, 'UTC'),${identityColumns},
  metric_name LowCardinality(String),
  value Float64,
  unit LowCardinality(String),
  metric_type LowCardinality(String),
  category LowCardinality(String),${provenanceColumns},
  INDEX idx_metrics_pod pod TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX idx_metrics_event_id event_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toDate(event_timestamp)
ORDER BY (cluster_id, namespace, workload, metric_name, container, event_timestamp, event_id)
SETTINGS index_granularity = 8192`,

    `CREATE TABLE IF NOT EXISTS ${db}.telemetry_kubernetes_events (
  event_timestamp DateTime64(3, 'UTC'),${identityColumns},
  reason LowCardinality(String),
  type LowCardinality(String),
  message String,
  message_truncated UInt8,
  resource_kind LowCardinality(String),
  resource_name String,
  resource_uid String,
  count UInt32,
  raw_payload String,
  raw_payload_truncated UInt8,${provenanceColumns},
  INDEX idx_events_reason reason TYPE set(64) GRANULARITY 4,
  INDEX idx_events_resource_name resource_name TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX idx_events_pod pod TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX idx_events_event_id event_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toDate(event_timestamp)
ORDER BY (cluster_id, namespace, resource_name, event_timestamp, event_id)
SETTINGS index_granularity = 8192`,

    ...retentionStatements(options),
  ];
}

/** Native TTL: ClickHouse expires rows during merges, so no delete job is needed. */
export function retentionStatements(options: SchemaOptions): string[] {
  const db = quoteIdentifier(options.database);
  const ttl = (days: number) =>
    `toDateTime(event_timestamp) + INTERVAL ${assertDays(days)} DAY DELETE`;
  return [
    `ALTER TABLE ${db}.telemetry_logs MODIFY TTL ${ttl(options.retention.logsDays)}`,
    `ALTER TABLE ${db}.telemetry_metrics MODIFY TTL ${ttl(options.retention.metricsDays)}`,
    `ALTER TABLE ${db}.telemetry_kubernetes_events MODIFY TTL ${ttl(options.retention.kubernetesEventsDays)}`,
  ];
}

export function truncateStatements(database: string): string[] {
  const db = quoteIdentifier(database);
  return telemetryTables.map(
    (table) => `TRUNCATE TABLE IF EXISTS ${db}.${table}`,
  );
}

/**
 * Database names come from configuration, not from requests, but they are the only
 * values that cannot be bound as query parameters, so they are still validated.
 */
export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))
    throw new Error(`Invalid ClickHouse identifier: ${value}`);
  return `\`${value}\``;
}

function assertDays(days: number): number {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650)
    throw new Error(`Invalid retention in days: ${days}`);
  return days;
}

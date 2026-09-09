import {
  assertScopedCluster,
  decodeTelemetryCursor,
  defaultQueryLimits,
  encodeTelemetryCursor,
  resourceTimelineFilters,
  type KubernetesEventQuery,
  type LogSearchQuery,
  type MetricBucket,
  type MetricQuery,
  type ResourceTimeline,
  type ResourceTimelineQuery,
  type StoredKubernetesEventRecord,
  type StoredLogRecord,
  type StoredMetricRecord,
  type TelemetryPage,
  type TelemetryQueryLimits,
  type TelemetryScope,
  type TelemetryStore,
  type TelemetryStoreWriteResult,
} from '@faultline/telemetry';
import type { ClickHouseConnection } from './connection';
import { quoteIdentifier, type TelemetryTable } from './schema';

export interface ClickHouseTelemetryStoreOptions {
  queryLimits?: TelemetryQueryLimits;
  /** Rejects the development "all clusters" scope; defaults to NODE_ENV=production. */
  requireExplicitScope?: boolean;
}

interface QueryFilter {
  column: string;
  parameter: string;
  type: string;
  value: unknown;
}

/**
 * Production `TelemetryStore`.
 *
 * Two rules hold for every statement here:
 *
 *  - SQL structure is written in this file only. Caller input reaches ClickHouse solely
 *    as a bound `query_params` value, so no request can add a clause, a column or a
 *    subquery. There is no pass-through SQL endpoint anywhere in the platform.
 *  - Every read is bounded before it is sent: a cluster the scope allows, a validated
 *    time window, a row limit, a server-side `max_execution_time` and a result-row cap.
 *
 * Reads deduplicate with `LIMIT 1 BY event_id`. `ReplacingMergeTree` collapses a
 * redelivered event eventually, but "eventually" is a background merge, so queries must
 * not depend on it having happened.
 */
export class ClickHouseTelemetryStore implements TelemetryStore {
  readonly name = 'clickhouse-telemetry-store';
  private readonly limits: TelemetryQueryLimits;
  private readonly requireExplicitScope: boolean;

  constructor(
    private readonly connection: ClickHouseConnection,
    options: ClickHouseTelemetryStoreOptions = {},
  ) {
    this.limits = options.queryLimits ?? defaultQueryLimits;
    this.requireExplicitScope =
      options.requireExplicitScope ?? process.env.NODE_ENV === 'production';
  }

  async storeLogs(
    records: readonly StoredLogRecord[],
  ): Promise<TelemetryStoreWriteResult> {
    return this.insert(
      'telemetry_logs',
      records.map((record) => ({
        event_timestamp: dateTime64(record.eventTimestamp),
        ...identityValues(record),
        severity: record.severity,
        stream: record.stream ?? '',
        message: record.message,
        message_truncated: record.messageTruncated ? 1 : 0,
        trace_id: record.traceId ?? '',
        request_id: record.requestId ?? '',
        raw_payload: record.rawPayload ?? '',
        raw_payload_truncated: record.rawPayloadTruncated ? 1 : 0,
        ...provenanceValues(record),
      })),
    );
  }

  async storeMetrics(
    records: readonly StoredMetricRecord[],
  ): Promise<TelemetryStoreWriteResult> {
    return this.insert(
      'telemetry_metrics',
      records.map((record) => ({
        event_timestamp: dateTime64(record.eventTimestamp),
        ...identityValues(record),
        metric_name: record.metricName,
        value: record.value,
        unit: record.unit ?? '',
        metric_type: record.metricType,
        category: record.category ?? '',
        ...provenanceValues(record),
      })),
    );
  }

  async storeKubernetesEvents(
    records: readonly StoredKubernetesEventRecord[],
  ): Promise<TelemetryStoreWriteResult> {
    return this.insert(
      'telemetry_kubernetes_events',
      records.map((record) => ({
        event_timestamp: dateTime64(record.eventTimestamp),
        ...identityValues(record),
        reason: record.reason,
        type: record.type,
        message: record.message,
        message_truncated: record.messageTruncated ? 1 : 0,
        resource_kind: record.resourceKind,
        resource_name: record.resourceName,
        resource_uid: record.resourceUid ?? '',
        count: record.count,
        raw_payload: record.rawPayload ?? '',
        raw_payload_truncated: record.rawPayloadTruncated ? 1 : 0,
        ...provenanceValues(record),
      })),
    );
  }

  async searchLogs(
    scope: TelemetryScope,
    query: LogSearchQuery,
  ): Promise<TelemetryPage<StoredLogRecord>> {
    const filters = [
      ...this.scopeFilters(scope, query.clusterId),
      ...identityFilters(query),
      ...(query.severity?.length
        ? [
            {
              column: 'severity',
              parameter: 'severities',
              type: 'Array(String)',
              value: [...query.severity],
            },
          ]
        : []),
      ...(query.traceId
        ? [
            {
              column: 'trace_id',
              parameter: 'traceId',
              type: 'String',
              value: query.traceId,
            },
          ]
        : []),
    ];
    const rows = await this.selectRows<LogRow>(
      'telemetry_logs',
      `event_timestamp_ms, ${identityProjection}, ${provenanceProjection},
       severity, stream, message, message_truncated, trace_id, request_id,
       raw_payload, raw_payload_truncated`,
      filters,
      query,
      query.search
        ? {
            // Matches the `lowerUTF8(message)` skip index exactly so it can be used.
            clause: 'lowerUTF8(message) LIKE {search:String}',
            params: {
              search: `%${escapeLikePattern(query.search.toLowerCase())}%`,
            },
          }
        : undefined,
    );
    return page(rows, query.limit, toLogRecord);
  }

  async searchKubernetesEvents(
    scope: TelemetryScope,
    query: KubernetesEventQuery,
  ): Promise<TelemetryPage<StoredKubernetesEventRecord>> {
    const filters: QueryFilter[] = [
      ...this.scopeFilters(scope, query.clusterId),
      ...identityFilters(query),
      ...optionalFilters([
        ['reason', 'reason', 'String', query.reason],
        ['`type`', 'eventType', 'String', query.type],
        ['resource_name', 'resourceName', 'String', query.resourceName],
        ['resource_kind', 'resourceKind', 'String', query.resourceKind],
      ]),
    ];
    const rows = await this.selectRows<KubernetesEventRow>(
      'telemetry_kubernetes_events',
      // `count` and `type` are quoted so they read as columns, never as functions.
      `event_timestamp_ms, ${identityProjection}, ${provenanceProjection},
       reason, \`type\`, message, message_truncated, resource_kind, resource_name,
       resource_uid, \`count\`, raw_payload, raw_payload_truncated`,
      filters,
      query,
    );
    return page(rows, query.limit, toKubernetesEventRecord);
  }

  async queryMetrics(
    scope: TelemetryScope,
    query: MetricQuery,
  ): Promise<TelemetryPage<MetricBucket>> {
    const filters: QueryFilter[] = [
      ...this.scopeFilters(scope, query.clusterId),
      ...identityFilters(query),
      {
        column: 'metric_name',
        parameter: 'metricName',
        type: 'String',
        value: query.metricName,
      },
    ];
    const { where, params } = this.buildWhere(filters, query);
    const aggregations = new Set(query.aggregations);
    // Deduplicate first: a redelivered sample would otherwise skew avg and count.
    const sql = `
      SELECT
        {startMs:Int64} +
          intDiv(toUnixTimestamp64Milli(event_timestamp) - {startMs:Int64}, {bucketMs:Int64})
          * {bucketMs:Int64} AS bucket_start_ms,
        cluster_id, namespace, workload, pod, container, node, service,
        metric_name, any(unit) AS unit,
        ${aggregations.has('min') ? 'min(value)' : 'NULL'} AS value_min,
        ${aggregations.has('max') ? 'max(value)' : 'NULL'} AS value_max,
        ${aggregations.has('avg') ? 'avg(value)' : 'NULL'} AS value_avg,
        count() AS value_count
      FROM (
        SELECT event_timestamp, cluster_id, namespace, workload, pod, container, node,
               service, metric_name, unit, value, event_id
        FROM ${this.table('telemetry_metrics')}
        ${where}
        ORDER BY event_timestamp, event_id
        LIMIT 1 BY event_id
      )
      GROUP BY bucket_start_ms, cluster_id, namespace, workload, pod, container, node,
               service, metric_name
      ORDER BY bucket_start_ms, namespace, workload, pod, container, node
      LIMIT {limit:UInt32}`;
    const rows = await this.run<MetricBucketRow>(sql, {
      ...params,
      bucketMs: query.bucketMs,
      limit: query.limit,
    });
    return {
      items: rows.map((row) => ({
        clusterId: row.cluster_id,
        ...optional('namespace', row.namespace),
        ...optional('workload', row.workload),
        ...optional('pod', row.pod),
        ...optional('container', row.container),
        ...optional('node', row.node),
        ...optional('service', row.service),
        metricName: row.metric_name,
        ...optional('unit', row.unit),
        bucketStart: new Date(Number(row.bucket_start_ms)).toISOString(),
        ...(aggregations.has('min') ? { min: Number(row.value_min) } : {}),
        ...(aggregations.has('max') ? { max: Number(row.value_max) } : {}),
        ...(aggregations.has('avg') ? { avg: Number(row.value_avg) } : {}),
        ...(aggregations.has('count')
          ? { count: Number(row.value_count) }
          : {}),
      })),
    };
  }

  async getResourceTimeline(
    scope: TelemetryScope,
    query: ResourceTimelineQuery,
  ): Promise<ResourceTimeline> {
    assertScopedCluster(scope, query.resource.clusterId);
    const filters = resourceTimelineFilters(query.resource);
    const window = { startTime: query.startTime, endTime: query.endTime };
    const { container: _container, ...eventFilters } = filters;
    const [logs, kubernetesEvents] = await Promise.all([
      this.searchLogs(scope, {
        clusterId: query.resource.clusterId,
        ...filters,
        ...(query.severity ? { severity: query.severity } : {}),
        ...window,
        limit: query.limit,
      }),
      this.searchKubernetesEvents(scope, {
        clusterId: query.resource.clusterId,
        ...eventFilters,
        ...window,
        limit: query.limit,
      }),
    ]);
    const metricNames = query.metricNames ?? [];
    let metrics: StoredMetricRecord[] = [];
    let metricsTruncated = false;
    if (metricNames.length) {
      const metricFilters: QueryFilter[] = [
        ...this.scopeFilters(scope, query.resource.clusterId),
        ...identityFilters(filters),
        {
          column: 'metric_name',
          parameter: 'metricNames',
          type: 'Array(String)',
          value: [...metricNames],
        },
      ];
      const rows = await this.selectRows<MetricRow>(
        'telemetry_metrics',
        `event_timestamp_ms, ${identityProjection}, ${provenanceProjection},
         metric_name, value, unit, metric_type, category`,
        metricFilters,
        { ...window, limit: query.limit },
      );
      metricsTruncated = rows.length > query.limit;
      metrics = rows.slice(0, query.limit).map(toMetricRecord);
    }
    return {
      resource: query.resource,
      window,
      logs: logs.items,
      kubernetesEvents: kubernetesEvents.items,
      metrics,
      truncated: {
        logs: Boolean(logs.nextCursor),
        kubernetesEvents: Boolean(kubernetesEvents.nextCursor),
        metrics: metricsTruncated,
      },
    };
  }

  async ping(): Promise<void> {
    await this.connection.ping();
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  private table(name: TelemetryTable): string {
    return `${quoteIdentifier(this.connection.options.database)}.${name}`;
  }

  private async insert(
    table: TelemetryTable,
    values: readonly Record<string, unknown>[],
  ): Promise<TelemetryStoreWriteResult> {
    if (!values.length) return { written: 0 };
    if (values.length > this.connection.options.maxInsertRows)
      throw new Error(
        `Refusing to insert ${values.length} rows; maximum is ${this.connection.options.maxInsertRows}`,
      );
    await this.connection.client.insert({
      table: `${this.connection.options.database}.${table}`,
      values,
      format: 'JSONEachRow',
    });
    return { written: values.length };
  }

  /**
   * Cluster isolation. The authorized cluster list is applied inside the query rather
   * than trusted from the caller's filter, so a request cannot reach another tenant's
   * rows even if a controller forgot to check.
   */
  private scopeFilters(
    scope: TelemetryScope,
    clusterId: string,
  ): QueryFilter[] {
    assertScopedCluster(scope, clusterId);
    if (scope.mode === 'all-development-clusters' && this.requireExplicitScope)
      throw new Error(
        'Unscoped telemetry queries are not permitted in this environment',
      );
    const clusterIds =
      scope.mode === 'clusters'
        ? scope.clusterIds.filter((id) => id === clusterId)
        : [clusterId];
    return [
      {
        column: 'cluster_id',
        parameter: 'clusterIds',
        type: 'Array(String)',
        value: clusterIds,
      },
    ];
  }

  private buildWhere(
    filters: readonly QueryFilter[],
    range: { startTime: string; endTime: string; cursor?: string },
  ): { where: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = {
      startMs: Date.parse(range.startTime),
      endMs: Date.parse(range.endTime),
    };
    const clauses = [
      `event_timestamp >= fromUnixTimestamp64Milli({startMs:Int64}, 'UTC')`,
      `event_timestamp < fromUnixTimestamp64Milli({endMs:Int64}, 'UTC')`,
    ];
    for (const filter of filters) {
      params[filter.parameter] = filter.value;
      clauses.push(
        filter.type.startsWith('Array(')
          ? `${filter.column} IN {${filter.parameter}:${filter.type}}`
          : `${filter.column} = {${filter.parameter}:${filter.type}}`,
      );
    }
    const cursor = decodeTelemetryCursor(range.cursor);
    if (cursor) {
      params.cursorMs = Date.parse(cursor.timestamp);
      params.cursorEventId = cursor.eventId;
      clauses.push(
        `(event_timestamp, event_id) < (fromUnixTimestamp64Milli({cursorMs:Int64}, 'UTC'), {cursorEventId:String})`,
      );
    }
    return { where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  private async selectRows<T>(
    table: TelemetryTable,
    projection: string,
    filters: readonly QueryFilter[],
    range: {
      startTime: string;
      endTime: string;
      limit: number;
      cursor?: string;
    },
    extra?: { clause: string; params: Record<string, unknown> },
  ): Promise<T[]> {
    const { where, params } = this.buildWhere(filters, range);
    const sql = `
      SELECT ${projection}
      FROM (
        SELECT *, toUnixTimestamp64Milli(event_timestamp) AS event_timestamp_ms,
               toUnixTimestamp64Milli(ingested_at) AS ingested_at_ms,
               toUnixTimestamp64Milli(processed_at) AS processed_at_ms
        FROM ${this.table(table)}
        ${where}${extra ? ` AND ${extra.clause}` : ''}
      )
      ORDER BY event_timestamp_ms DESC, event_id DESC
      LIMIT 1 BY event_id
      LIMIT {limit:UInt32}`;
    return this.run<T>(sql, {
      ...params,
      ...extra?.params,
      // One extra row reveals whether another page exists without a second query.
      limit: range.limit + 1,
    });
  }

  private async run<T>(
    query: string,
    query_params: Record<string, unknown>,
  ): Promise<T[]> {
    const result = await this.connection.client.query({
      query,
      query_params,
      format: 'JSONEachRow',
      clickhouse_settings: {
        // Server-side ceilings, so a slow or wide query fails instead of pinning a node.
        max_execution_time: Math.max(
          1,
          Math.ceil(this.limits.queryTimeoutMs / 1000),
        ),
        timeout_overflow_mode: 'throw',
        max_result_rows: String(this.limits.maxLimit * 4),
        result_overflow_mode: 'throw',
      },
      abort_signal: AbortSignal.timeout(this.limits.queryTimeoutMs),
    });
    return result.json<T>();
  }
}

const identityProjection =
  'cluster_id, namespace, workload, pod, container, node, service';
const provenanceProjection =
  'event_id, ingested_at_ms, processed_at_ms, attributes, schema_version';

interface IdentityRow {
  cluster_id: string;
  namespace: string;
  workload: string;
  pod: string;
  container: string;
  node: string;
  service: string;
}

interface ProvenanceRow extends IdentityRow {
  event_timestamp_ms: string;
  event_id: string;
  ingested_at_ms: string;
  processed_at_ms: string;
  attributes: Record<string, string>;
  schema_version: number;
}

interface LogRow extends ProvenanceRow {
  severity: string;
  stream: string;
  message: string;
  message_truncated: number;
  trace_id: string;
  request_id: string;
  raw_payload: string;
  raw_payload_truncated: number;
}

interface MetricRow extends ProvenanceRow {
  metric_name: string;
  value: number;
  unit: string;
  metric_type: string;
  category: string;
}

interface KubernetesEventRow extends ProvenanceRow {
  reason: string;
  type: string;
  message: string;
  message_truncated: number;
  resource_kind: string;
  resource_name: string;
  resource_uid: string;
  count: number;
  raw_payload: string;
  raw_payload_truncated: number;
}

interface MetricBucketRow extends IdentityRow {
  bucket_start_ms: string;
  metric_name: string;
  unit: string;
  value_min: number | null;
  value_max: number | null;
  value_avg: number | null;
  value_count: string;
}

/** ClickHouse columns are non-nullable; empty string means "not present". */
function optional<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function identityValues(record: {
  clusterId: string;
  namespace?: string;
  workload?: string;
  pod?: string;
  container?: string;
  node?: string;
  service?: string;
}): Record<string, string> {
  return {
    cluster_id: record.clusterId,
    namespace: record.namespace ?? '',
    workload: record.workload ?? '',
    pod: record.pod ?? '',
    container: record.container ?? '',
    node: record.node ?? '',
    service: record.service ?? '',
  };
}

function provenanceValues(record: {
  eventId: string;
  ingestedAt: string;
  processedAt?: string;
  attributes: Readonly<Record<string, string>>;
  schemaVersion: number;
}): Record<string, unknown> {
  return {
    event_id: record.eventId,
    ingested_at: dateTime64(record.ingestedAt),
    // The Unix epoch is the "absent" marker; the column is not Nullable.
    processed_at: record.processedAt
      ? dateTime64(record.processedAt)
      : '1970-01-01 00:00:00.000',
    attributes: record.attributes,
    schema_version: record.schemaVersion,
  };
}

function commonRecord(row: ProvenanceRow) {
  const processedAtMs = Number(row.processed_at_ms);
  return {
    eventId: row.event_id,
    eventTimestamp: new Date(Number(row.event_timestamp_ms)).toISOString(),
    ingestedAt: new Date(Number(row.ingested_at_ms)).toISOString(),
    ...(processedAtMs > 0
      ? { processedAt: new Date(processedAtMs).toISOString() }
      : {}),
    clusterId: row.cluster_id,
    ...optional('namespace', row.namespace),
    ...optional('workload', row.workload),
    ...optional('pod', row.pod),
    ...optional('container', row.container),
    ...optional('node', row.node),
    ...optional('service', row.service),
    attributes: row.attributes ?? {},
    schemaVersion: Number(row.schema_version),
  };
}

function toLogRecord(row: LogRow): StoredLogRecord {
  return {
    ...commonRecord(row),
    severity: row.severity as StoredLogRecord['severity'],
    ...(row.stream
      ? { stream: row.stream as NonNullable<StoredLogRecord['stream']> }
      : {}),
    message: row.message,
    messageTruncated: Boolean(Number(row.message_truncated)),
    ...optional('traceId', row.trace_id),
    ...optional('requestId', row.request_id),
    ...optional('rawPayload', row.raw_payload),
    rawPayloadTruncated: Boolean(Number(row.raw_payload_truncated)),
  };
}

function toMetricRecord(row: MetricRow): StoredMetricRecord {
  return {
    ...commonRecord(row),
    metricName: row.metric_name,
    value: Number(row.value),
    ...optional('unit', row.unit),
    metricType: row.metric_type as StoredMetricRecord['metricType'],
    ...(row.category
      ? {
          category: row.category as NonNullable<StoredMetricRecord['category']>,
        }
      : {}),
  };
}

function toKubernetesEventRecord(
  row: KubernetesEventRow,
): StoredKubernetesEventRecord {
  return {
    ...commonRecord(row),
    reason: row.reason,
    type: row.type as StoredKubernetesEventRecord['type'],
    message: row.message,
    messageTruncated: Boolean(Number(row.message_truncated)),
    resourceKind: row.resource_kind,
    resourceName: row.resource_name,
    ...optional('resourceUid', row.resource_uid),
    count: Number(row.count),
    ...optional('rawPayload', row.raw_payload),
    rawPayloadTruncated: Boolean(Number(row.raw_payload_truncated)),
  };
}

function identityFilters(query: {
  namespace?: string;
  workload?: string;
  pod?: string;
  container?: string;
  node?: string;
}): QueryFilter[] {
  return optionalFilters([
    ['namespace', 'namespace', 'String', query.namespace],
    ['workload', 'workload', 'String', query.workload],
    ['pod', 'pod', 'String', query.pod],
    ['container', 'container', 'String', query.container],
    ['node', 'node', 'String', query.node],
  ]);
}

function optionalFilters(
  entries: readonly [string, string, string, unknown][],
): QueryFilter[] {
  return entries
    .filter(([, , , value]) => value !== undefined && value !== '')
    .map(([column, parameter, type, value]) => ({
      column,
      parameter,
      type,
      value,
    }));
}

/**
 * Escapes LIKE wildcards in a caller-supplied term.
 *
 * The term is bound as a parameter, so this is about meaning rather than safety: without
 * it a search for `50%` would match far more than the user asked for.
 */
const likeWildcards = /[\\%_]/g;
function escapeLikePattern(value: string): string {
  return value.replace(likeWildcards, (character) => '\\' + character);
}

/** `DateTime64(3, 'UTC')` literal; the JS ISO string is already UTC. */
function dateTime64(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '');
}

function page<TRow extends { event_timestamp_ms: string; event_id: string }, T>(
  rows: readonly TRow[],
  limit: number,
  map: (row: TRow) => T,
): TelemetryPage<T> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    ...(rows.length > limit && last
      ? {
          nextCursor: encodeTelemetryCursor({
            timestamp: new Date(Number(last.event_timestamp_ms)).toISOString(),
            eventId: last.event_id,
          }),
        }
      : {}),
  };
}

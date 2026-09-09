import {
  assertScopedCluster,
  decodeTelemetryCursor,
  encodeTelemetryCursor,
  type KubernetesEventQuery,
  type LogSearchQuery,
  type MetricBucket,
  type MetricQuery,
  type ResourceTimeline,
  type ResourceTimelineQuery,
  type StoredKubernetesEventRecord,
  type StoredLogRecord,
  type StoredMetricRecord,
  type StoredTelemetryIdentity,
  type TelemetryPage,
  type TelemetryScope,
  type TelemetryStore,
  type TelemetryStoreWriteResult,
} from './store';
import { resourceTimelineFilters } from './query-safety';

interface RetentionDays {
  logs: number;
  metrics: number;
  kubernetesEvents: number;
}

export interface InMemoryTelemetryStoreOptions {
  /** Rows retained per signal before the oldest are discarded. */
  capacity?: number;
  /** Mirrors the ClickHouse TTL so development behaves like production. */
  retentionDays?: Partial<RetentionDays>;
  now?: () => number;
}

const defaultRetention: RetentionDays = {
  logs: 7,
  metrics: 14,
  kubernetesEvents: 30,
};

/**
 * Bounded process-local telemetry store.
 *
 * It is the reference implementation of the query semantics ClickHouse must match:
 * scope enforcement, descending keyset pagination, event-ID deduplication, and
 * retention cutoffs. Tests run the same contract suite against both adapters.
 */
export class InMemoryTelemetryStore implements TelemetryStore {
  readonly name = 'telemetry-store';
  private readonly logs = new Map<string, StoredLogRecord>();
  private readonly metrics = new Map<string, StoredMetricRecord>();
  private readonly kubernetesEvents = new Map<
    string,
    StoredKubernetesEventRecord
  >();
  private readonly capacity: number;
  private readonly retentionDays: RetentionDays;
  private readonly now: () => number;
  private closed = false;

  constructor(options: InMemoryTelemetryStoreOptions = {}) {
    this.capacity = options.capacity ?? 50_000;
    this.retentionDays = { ...defaultRetention, ...options.retentionDays };
    this.now = options.now ?? Date.now;
  }

  async storeLogs(
    records: readonly StoredLogRecord[],
  ): Promise<TelemetryStoreWriteResult> {
    return this.write(this.logs, records, this.retentionDays.logs);
  }

  async storeMetrics(
    records: readonly StoredMetricRecord[],
  ): Promise<TelemetryStoreWriteResult> {
    return this.write(this.metrics, records, this.retentionDays.metrics);
  }

  async storeKubernetesEvents(
    records: readonly StoredKubernetesEventRecord[],
  ): Promise<TelemetryStoreWriteResult> {
    return this.write(
      this.kubernetesEvents,
      records,
      this.retentionDays.kubernetesEvents,
    );
  }

  async searchLogs(
    scope: TelemetryScope,
    query: LogSearchQuery,
  ): Promise<TelemetryPage<StoredLogRecord>> {
    assertScopedCluster(scope, query.clusterId);
    const severities = query.severity && new Set(query.severity);
    const search = query.search?.toLowerCase();
    const matches = this.rows(this.logs, this.retentionDays.logs).filter(
      (row) =>
        row.clusterId === query.clusterId &&
        withinRange(row.eventTimestamp, query) &&
        matchesIdentity(row, query) &&
        (!severities || severities.has(row.severity)) &&
        (!search || row.message.toLowerCase().includes(search)) &&
        (!query.traceId || row.traceId === query.traceId),
    );
    return paginate(matches, query.limit, query.cursor);
  }

  async searchKubernetesEvents(
    scope: TelemetryScope,
    query: KubernetesEventQuery,
  ): Promise<TelemetryPage<StoredKubernetesEventRecord>> {
    assertScopedCluster(scope, query.clusterId);
    const matches = this.rows(
      this.kubernetesEvents,
      this.retentionDays.kubernetesEvents,
    ).filter(
      (row) =>
        row.clusterId === query.clusterId &&
        withinRange(row.eventTimestamp, query) &&
        matchesIdentity(row, query) &&
        (!query.reason || row.reason === query.reason) &&
        (!query.type || row.type === query.type) &&
        (!query.resourceName || row.resourceName === query.resourceName) &&
        (!query.resourceKind || row.resourceKind === query.resourceKind),
    );
    return paginate(matches, query.limit, query.cursor);
  }

  async queryMetrics(
    scope: TelemetryScope,
    query: MetricQuery,
  ): Promise<TelemetryPage<MetricBucket>> {
    assertScopedCluster(scope, query.clusterId);
    const matches = this.rows(this.metrics, this.retentionDays.metrics).filter(
      (row) =>
        row.clusterId === query.clusterId &&
        row.metricName === query.metricName &&
        withinRange(row.eventTimestamp, query) &&
        matchesIdentity(row, query),
    );
    const startMs = Date.parse(query.startTime);
    const groups = new Map<
      string,
      { rows: StoredMetricRecord[]; bucketStart: number }
    >();
    for (const row of matches) {
      const offset = Date.parse(row.eventTimestamp) - startMs;
      const bucketStart =
        startMs + Math.floor(offset / query.bucketMs) * query.bucketMs;
      const key = JSON.stringify([
        bucketStart,
        row.namespace ?? '',
        row.workload ?? '',
        row.pod ?? '',
        row.container ?? '',
        row.node ?? '',
      ]);
      const group = groups.get(key) ?? { rows: [], bucketStart };
      group.rows.push(row);
      groups.set(key, group);
    }
    const aggregations = new Set(query.aggregations);
    const buckets = [...groups.values()]
      .sort(
        (a, b) =>
          a.bucketStart - b.bucketStart ||
          seriesKey(a.rows[0]!).localeCompare(seriesKey(b.rows[0]!)),
      )
      .map(({ rows, bucketStart }): MetricBucket => {
        const values = rows.map((row) => row.value);
        const sample = rows[0]!;
        return {
          clusterId: sample.clusterId,
          ...(sample.namespace ? { namespace: sample.namespace } : {}),
          ...(sample.workload ? { workload: sample.workload } : {}),
          ...(sample.pod ? { pod: sample.pod } : {}),
          ...(sample.container ? { container: sample.container } : {}),
          ...(sample.node ? { node: sample.node } : {}),
          metricName: sample.metricName,
          ...(sample.unit ? { unit: sample.unit } : {}),
          bucketStart: new Date(bucketStart).toISOString(),
          ...(aggregations.has('min') ? { min: Math.min(...values) } : {}),
          ...(aggregations.has('max') ? { max: Math.max(...values) } : {}),
          ...(aggregations.has('avg')
            ? {
                avg:
                  values.reduce((sum, value) => sum + value, 0) / values.length,
              }
            : {}),
          ...(aggregations.has('count') ? { count: values.length } : {}),
        };
      });
    return { items: buckets.slice(0, query.limit) };
  }

  async getResourceTimeline(
    scope: TelemetryScope,
    query: ResourceTimelineQuery,
  ): Promise<ResourceTimeline> {
    assertScopedCluster(scope, query.resource.clusterId);
    const filters = resourceTimelineFilters(query.resource);
    const window = { startTime: query.startTime, endTime: query.endTime };
    const logs = await this.searchLogs(scope, {
      clusterId: query.resource.clusterId,
      ...filters,
      ...(query.severity ? { severity: query.severity } : {}),
      ...window,
      limit: query.limit,
    });
    const kubernetesEvents = await this.searchKubernetesEvents(scope, {
      clusterId: query.resource.clusterId,
      ...timelineEventFilters(filters),
      ...window,
      limit: query.limit,
    });
    const metrics: StoredMetricRecord[] = [];
    let metricsTruncated = false;
    for (const metricName of query.metricNames ?? []) {
      const rows = this.rows(this.metrics, this.retentionDays.metrics).filter(
        (row) =>
          row.clusterId === query.resource.clusterId &&
          row.metricName === metricName &&
          withinRange(row.eventTimestamp, window) &&
          matchesIdentity(row, filters),
      );
      if (rows.length > query.limit) metricsTruncated = true;
      metrics.push(...rows.slice(0, query.limit));
    }
    metrics.sort(compareDescending);
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
    if (this.closed) throw new Error('Telemetry store closed');
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private write<T extends { eventId: string; eventTimestamp: string }>(
    table: Map<string, T>,
    records: readonly T[],
    retentionDays: number,
  ): TelemetryStoreWriteResult {
    if (this.closed) throw new Error('Telemetry store closed');
    const cutoff = this.now() - retentionDays * 86_400_000;
    let written = 0;
    for (const record of records) {
      if (Date.parse(record.eventTimestamp) < cutoff) continue;
      // Last write wins on a repeated event ID, matching ReplacingMergeTree.
      table.set(record.eventId, record);
      written++;
    }
    while (table.size > this.capacity) table.delete(table.keys().next().value!);
    return { written };
  }

  private rows<T extends { eventTimestamp: string }>(
    table: Map<string, T>,
    retentionDays: number,
  ): T[] {
    const cutoff = this.now() - retentionDays * 86_400_000;
    return [...table.values()].filter(
      (row) => Date.parse(row.eventTimestamp) >= cutoff,
    );
  }
}

function seriesKey(row: StoredMetricRecord): string {
  return [
    row.namespace ?? '',
    row.workload ?? '',
    row.pod ?? '',
    row.container ?? '',
    row.node ?? '',
  ].join('/');
}

function withinRange(
  timestamp: string,
  range: { startTime: string; endTime: string },
): boolean {
  const value = Date.parse(timestamp);
  return (
    value >= Date.parse(range.startTime) && value < Date.parse(range.endTime)
  );
}

function matchesIdentity(
  row: StoredTelemetryIdentity,
  filters: {
    namespace?: string;
    workload?: string;
    pod?: string;
    container?: string;
    node?: string;
  },
): boolean {
  return (
    (!filters.namespace || row.namespace === filters.namespace) &&
    (!filters.workload || row.workload === filters.workload) &&
    (!filters.pod || row.pod === filters.pod) &&
    (!filters.container || row.container === filters.container) &&
    (!filters.node || row.node === filters.node)
  );
}

/** Kubernetes events are recorded against the pod, not the container inside it. */
function timelineEventFilters(filters: {
  namespace?: string;
  workload?: string;
  pod?: string;
  container?: string;
  node?: string;
}): { namespace?: string; workload?: string; pod?: string; node?: string } {
  const { container: _container, ...rest } = filters;
  return rest;
}

function compareDescending(
  a: { eventTimestamp: string; eventId: string },
  b: { eventTimestamp: string; eventId: string },
): number {
  return (
    Date.parse(b.eventTimestamp) - Date.parse(a.eventTimestamp) ||
    (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0)
  );
}

function paginate<T extends { eventTimestamp: string; eventId: string }>(
  rows: readonly T[],
  limit: number,
  cursor?: string,
): TelemetryPage<T> {
  const after = decodeTelemetryCursor(cursor);
  const ordered = [...rows].sort(compareDescending);
  const filtered = after
    ? ordered.filter((row) => {
        const rowMs = Date.parse(row.eventTimestamp);
        const cursorMs = Date.parse(after.timestamp);
        return (
          rowMs < cursorMs ||
          (rowMs === cursorMs && row.eventId < after.eventId)
        );
      })
    : ordered;
  const items = filtered.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(filtered.length > limit && last
      ? {
          nextCursor: encodeTelemetryCursor({
            timestamp: last.eventTimestamp,
            eventId: last.eventId,
          }),
        }
      : {}),
  };
}

let developmentStore: InMemoryTelemetryStore | undefined;

/**
 * Process-local telemetry store shared by test-mode wiring, mirroring
 * `getDevelopmentQueue` and `getDevelopmentIncidentRepository`: the storage consumer
 * writes and the API reads the same rows.
 */
export function getDevelopmentTelemetryStore(): InMemoryTelemetryStore {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development telemetry store is disabled in production');
  return (developmentStore ??= new InMemoryTelemetryStore());
}

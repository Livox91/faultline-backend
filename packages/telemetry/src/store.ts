import type {
  KubernetesEvent,
  LogEvent,
  MetricEvent,
  TelemetryEvent,
} from './index';
import type { TelemetryResourceRef } from './resource-id';

/**
 * Telemetry storage boundary.
 *
 * Application and domain code depends on this interface only; no caller imports a
 * ClickHouse client. `@faultline/clickhouse` supplies the production adapter and
 * `InMemoryTelemetryStore` the development/test adapter.
 */
export const TELEMETRY_STORE = Symbol('faultline.telemetry-store');

/** Bumped when stored row shapes change in a way readers must know about. */
export const TELEMETRY_STORAGE_SCHEMA_VERSION = 1;

export const logSeverities = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'unknown',
] as const;
export type LogSeverity = (typeof logSeverities)[number];

/** Severities treated as errors by incident-window lookups. */
export const errorSeverities: readonly LogSeverity[] = ['error', 'fatal'];

export interface StoredTelemetryIdentity {
  clusterId: string;
  namespace?: string;
  workload?: string;
  pod?: string;
  container?: string;
  node?: string;
  service?: string;
}

export interface StoredLogRecord extends StoredTelemetryIdentity {
  eventId: string;
  eventTimestamp: string;
  ingestedAt: string;
  processedAt?: string;
  severity: LogSeverity;
  stream?: 'stdout' | 'stderr';
  message: string;
  messageTruncated: boolean;
  traceId?: string;
  requestId?: string;
  attributes: Readonly<Record<string, string>>;
  rawPayload?: string;
  rawPayloadTruncated: boolean;
  schemaVersion: number;
}

export interface StoredMetricRecord extends StoredTelemetryIdentity {
  eventId: string;
  eventTimestamp: string;
  ingestedAt: string;
  processedAt?: string;
  metricName: string;
  value: number;
  unit?: string;
  metricType: 'gauge' | 'counter';
  category?: 'usage' | 'configuration' | 'state';
  attributes: Readonly<Record<string, string>>;
  schemaVersion: number;
}

export interface StoredKubernetesEventRecord extends StoredTelemetryIdentity {
  eventId: string;
  eventTimestamp: string;
  ingestedAt: string;
  processedAt?: string;
  reason: string;
  type: 'Normal' | 'Warning';
  message: string;
  messageTruncated: boolean;
  resourceKind: string;
  resourceName: string;
  resourceUid?: string;
  count: number;
  attributes: Readonly<Record<string, string>>;
  rawPayload?: string;
  rawPayloadTruncated: boolean;
  schemaVersion: number;
}

/**
 * Authorized query scope. Never derived from a request body, query string or client
 * header: callers resolve it from the authenticated principal before touching storage,
 * and every adapter re-applies it inside the query it builds.
 */
export type TelemetryScope =
  | { readonly mode: 'clusters'; readonly clusterIds: readonly string[] }
  /** Development/test only; adapters reject it when NODE_ENV is production. */
  | { readonly mode: 'all-development-clusters' };

export function clusterScope(...clusterIds: readonly string[]): TelemetryScope {
  return { mode: 'clusters', clusterIds: [...new Set(clusterIds)] };
}

export function scopeAllowsCluster(
  scope: TelemetryScope,
  clusterId: string,
): boolean {
  return (
    scope.mode === 'all-development-clusters' ||
    scope.clusterIds.includes(clusterId)
  );
}

export interface TelemetryTimeRange {
  startTime: string;
  endTime: string;
}

export interface LogSearchQuery extends TelemetryTimeRange {
  clusterId: string;
  namespace?: string;
  workload?: string;
  pod?: string;
  container?: string;
  node?: string;
  severity?: readonly LogSeverity[];
  /** Case-insensitive substring match on the stored message. Not full-text search. */
  search?: string;
  traceId?: string;
  limit: number;
  cursor?: string;
}

export type MetricAggregation = 'min' | 'max' | 'avg' | 'count';

export interface MetricQuery extends TelemetryTimeRange {
  clusterId: string;
  metricName: string;
  namespace?: string;
  workload?: string;
  pod?: string;
  container?: string;
  node?: string;
  /** Bucket width in milliseconds; results are one row per bucket per series. */
  bucketMs: number;
  aggregations: readonly MetricAggregation[];
  limit: number;
}

export interface MetricBucket extends StoredTelemetryIdentity {
  metricName: string;
  unit?: string;
  bucketStart: string;
  min?: number;
  max?: number;
  avg?: number;
  count?: number;
}

export interface KubernetesEventQuery extends TelemetryTimeRange {
  clusterId: string;
  namespace?: string;
  workload?: string;
  pod?: string;
  node?: string;
  reason?: string;
  type?: 'Normal' | 'Warning';
  resourceName?: string;
  resourceKind?: string;
  limit: number;
  cursor?: string;
}

export interface ResourceTimelineQuery extends TelemetryTimeRange {
  resource: TelemetryResourceRef;
  /** Per-signal cap; the timeline is a summary, not a bulk export. */
  limit: number;
  severity?: readonly LogSeverity[];
  /** Restricts the metric samples included; empty means no metric samples. */
  metricNames?: readonly string[];
}

export interface ResourceTimeline {
  resource: TelemetryResourceRef;
  window: TelemetryTimeRange;
  logs: readonly StoredLogRecord[];
  kubernetesEvents: readonly StoredKubernetesEventRecord[];
  metrics: readonly StoredMetricRecord[];
  truncated: {
    logs: boolean;
    kubernetesEvents: boolean;
    metrics: boolean;
  };
}

export interface TelemetryPage<T> {
  items: readonly T[];
  /** Opaque continuation token; absent when the result set is exhausted. */
  nextCursor?: string;
}

export interface TelemetryStoreWriteResult {
  /** Rows accepted by the store. Adapters may deduplicate identical event IDs later. */
  written: number;
}

/**
 * The storage-side contract. Writes are batched by the caller (see `TelemetryBatcher`);
 * every read is scope-bounded and result-bounded.
 */
export interface TelemetryStore {
  storeLogs(
    records: readonly StoredLogRecord[],
  ): Promise<TelemetryStoreWriteResult>;
  storeMetrics(
    records: readonly StoredMetricRecord[],
  ): Promise<TelemetryStoreWriteResult>;
  storeKubernetesEvents(
    records: readonly StoredKubernetesEventRecord[],
  ): Promise<TelemetryStoreWriteResult>;

  searchLogs(
    scope: TelemetryScope,
    query: LogSearchQuery,
  ): Promise<TelemetryPage<StoredLogRecord>>;
  queryMetrics(
    scope: TelemetryScope,
    query: MetricQuery,
  ): Promise<TelemetryPage<MetricBucket>>;
  searchKubernetesEvents(
    scope: TelemetryScope,
    query: KubernetesEventQuery,
  ): Promise<TelemetryPage<StoredKubernetesEventRecord>>;
  getResourceTimeline(
    scope: TelemetryScope,
    query: ResourceTimelineQuery,
  ): Promise<ResourceTimeline>;

  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Raised when a caller asks for telemetry outside its authorized scope. */
export class TelemetryScopeError extends Error {
  readonly code = 'TELEMETRY_SCOPE_DENIED';
  constructor(message = 'Cluster is outside the authorized telemetry scope') {
    super(message);
    this.name = 'TelemetryScopeError';
  }
}

/** Raised when a query violates a configured safety bound. */
export class TelemetryQueryError extends Error {
  readonly code = 'TELEMETRY_QUERY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryQueryError';
  }
}

export function assertScopedCluster(
  scope: TelemetryScope,
  clusterId: string,
): void {
  if (!scopeAllowsCluster(scope, clusterId)) throw new TelemetryScopeError();
}

export interface TelemetryPayloadLimits {
  /** Longest stored log/event message in UTF-8 bytes before truncation. */
  maxMessageBytes: number;
  /** Longest stored raw payload in UTF-8 bytes before truncation. */
  maxRawPayloadBytes: number;
  /** Longest stored attribute value in UTF-8 bytes before truncation. */
  maxAttributeValueBytes: number;
  /** Attributes retained per record; extras are dropped in sorted key order. */
  maxAttributeCount: number;
}

export const defaultPayloadLimits: TelemetryPayloadLimits = {
  maxMessageBytes: 32_768,
  maxRawPayloadBytes: 65_536,
  maxAttributeValueBytes: 4_096,
  maxAttributeCount: 128,
};

export const TRUNCATION_MARKER = '[truncated]';

/** Truncates on a UTF-8 code point boundary so stored text stays valid. */
export function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  let keep = Math.max(0, maxBytes - markerBytes);
  // Never split a multi-byte code point: walk back off continuation bytes.
  while (keep > 0 && (buffer[keep]! & 0xc0) === 0x80) keep--;
  return {
    value: buffer.subarray(0, keep).toString('utf8') + TRUNCATION_MARKER,
    truncated: true,
  };
}

function flattenAttributes(
  attributes: Readonly<Record<string, unknown>>,
  limits: TelemetryPayloadLimits,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(attributes).sort()) {
    if (Object.keys(result).length >= limits.maxAttributeCount) break;
    const value = attributes[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) continue;
    result[key] = truncateUtf8(text, limits.maxAttributeValueBytes).value;
  }
  return result;
}

function storedRawPayload(
  raw: unknown,
  limits: TelemetryPayloadLimits,
): { rawPayload?: string; rawPayloadTruncated: boolean } {
  if (raw === undefined || raw === null) return { rawPayloadTruncated: false };
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (text === undefined) return { rawPayloadTruncated: false };
  const { value, truncated } = truncateUtf8(text, limits.maxRawPayloadBytes);
  return { rawPayload: value, rawPayloadTruncated: truncated };
}

const traceKeys = ['trace_id', 'traceId', 'trace.id', 'traceID'];
const requestKeys = [
  'request_id',
  'requestId',
  'request.id',
  'http.request.id',
  'correlation_id',
];

function firstAttribute(
  attributes: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function storedIdentity(event: TelemetryEvent): StoredTelemetryIdentity {
  return {
    clusterId: event.clusterId,
    ...(event.namespace ? { namespace: event.namespace } : {}),
    ...(event.workload ? { workload: event.workload } : {}),
    ...(event.pod ? { pod: event.pod } : {}),
    ...(event.container ? { container: event.container } : {}),
    ...(event.node ? { node: event.node } : {}),
    ...(event.service ? { service: event.service } : {}),
  };
}

/** Normalized event to stored row. Pure, so adapters and tests share one mapping. */
export function toStoredLogRecord(
  event: LogEvent,
  limits: TelemetryPayloadLimits = defaultPayloadLimits,
): StoredLogRecord {
  const message = truncateUtf8(event.message, limits.maxMessageBytes);
  const traceId = firstAttribute(event.attributes, traceKeys);
  const requestId = firstAttribute(event.attributes, requestKeys);
  return {
    eventId: event.id,
    eventTimestamp: event.timestamp,
    ingestedAt: event.ingestedAt ?? event.timestamp,
    ...(event.processedAt ? { processedAt: event.processedAt } : {}),
    ...storedIdentity(event),
    severity: event.level,
    ...(event.stream ? { stream: event.stream } : {}),
    message: message.value,
    messageTruncated: message.truncated,
    ...(traceId ? { traceId } : {}),
    ...(requestId ? { requestId } : {}),
    attributes: flattenAttributes(event.attributes, limits),
    ...storedRawPayload(event.raw, limits),
    schemaVersion: TELEMETRY_STORAGE_SCHEMA_VERSION,
  };
}

export function toStoredMetricRecord(
  event: MetricEvent,
  limits: TelemetryPayloadLimits = defaultPayloadLimits,
): StoredMetricRecord {
  return {
    eventId: event.id,
    eventTimestamp: event.timestamp,
    ingestedAt: event.ingestedAt ?? event.timestamp,
    ...(event.processedAt ? { processedAt: event.processedAt } : {}),
    ...storedIdentity(event),
    metricName: event.name,
    value: event.value,
    ...(event.unit ? { unit: event.unit } : {}),
    metricType: event.metricType,
    ...(event.category ? { category: event.category } : {}),
    attributes: flattenAttributes(event.attributes, limits),
    schemaVersion: TELEMETRY_STORAGE_SCHEMA_VERSION,
  };
}

export function toStoredKubernetesEventRecord(
  event: KubernetesEvent,
  limits: TelemetryPayloadLimits = defaultPayloadLimits,
): StoredKubernetesEventRecord {
  const message = truncateUtf8(event.message, limits.maxMessageBytes);
  return {
    eventId: event.id,
    eventTimestamp: event.timestamp,
    ingestedAt: event.ingestedAt ?? event.timestamp,
    ...(event.processedAt ? { processedAt: event.processedAt } : {}),
    ...storedIdentity(event),
    reason: event.reason,
    type: event.type,
    message: message.value,
    messageTruncated: message.truncated,
    resourceKind: event.involvedObject.kind,
    resourceName: event.involvedObject.name,
    ...(event.involvedObject.uid
      ? { resourceUid: event.involvedObject.uid }
      : {}),
    count: event.count ?? 1,
    attributes: flattenAttributes(event.attributes, limits),
    ...storedRawPayload(event.raw, limits),
    schemaVersion: TELEMETRY_STORAGE_SCHEMA_VERSION,
  };
}

/** Cursor over `(eventTimestamp, eventId)` for descending keyset pagination. */
export interface TelemetryCursor {
  timestamp: string;
  eventId: string;
}

export function encodeTelemetryCursor(cursor: TelemetryCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.timestamp, cursor.eventId]),
    'utf8',
  ).toString('base64url');
}

export function decodeTelemetryCursor(
  value: unknown,
): TelemetryCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    throw new TelemetryQueryError('Invalid cursor');
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !Number.isFinite(Date.parse(parsed[0]))
    )
      throw new Error('malformed cursor');
    return { timestamp: parsed[0], eventId: parsed[1] };
  } catch {
    throw new TelemetryQueryError('Invalid cursor');
  }
}

import {
  TelemetryQueryError,
  decodeTelemetryCursor,
  logSeverities,
  type KubernetesEventQuery,
  type LogSearchQuery,
  type LogSeverity,
  type MetricAggregation,
  type MetricQuery,
  type ResourceTimelineQuery,
} from './store';
import {
  parseTelemetryResourceId,
  type TelemetryResourceRef,
} from './resource-id';

/**
 * Bounds every telemetry read before it reaches an adapter.
 *
 * ClickHouse will happily scan a year of a multi-cluster table, so the API never
 * forwards a raw filter set: each query must name a cluster and a bounded window,
 * every filter value is validated here, and result sizes are clamped. Nothing in
 * the request can influence SQL structure, only parameter values.
 */
export interface TelemetryQueryLimits {
  /** Widest allowed `endTime - startTime` for log/event searches and timelines. */
  maxTimeRangeMs: number;
  /** Widest allowed window for metric aggregation, which scans fewer bytes per row. */
  maxMetricTimeRangeMs: number;
  /** Largest allowed page size. */
  maxLimit: number;
  /** Page size applied when the caller does not ask for one. */
  defaultLimit: number;
  /** Server-side execution timeout handed to the adapter. */
  queryTimeoutMs: number;
  /** Narrowest metric bucket, guarding against million-bucket responses. */
  minBucketMs: number;
  /** Largest number of aggregation buckets returned in one response. */
  maxBuckets: number;
}

export const defaultQueryLimits: TelemetryQueryLimits = {
  maxTimeRangeMs: 86_400_000,
  maxMetricTimeRangeMs: 604_800_000,
  maxLimit: 500,
  defaultLimit: 100,
  queryTimeoutMs: 10_000,
  minBucketMs: 1_000,
  maxBuckets: 1_000,
};

const identifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,251})$/;
const severitySet: ReadonlySet<string> = new Set(logSeverities);
const aggregationSet: ReadonlySet<string> = new Set([
  'min',
  'max',
  'avg',
  'count',
]);

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function invalid(field: string): never {
  throw new TelemetryQueryError(`Invalid ${field} filter`);
}

/**
 * Kubernetes-ish identifiers only. Rejecting quotes, whitespace and control
 * characters keeps these values obviously inert even though adapters bind them as
 * query parameters rather than interpolating them.
 */
export function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  const trimmed = value.trim();
  if (!identifierPattern.test(trimmed)) invalid(field);
  return trimmed;
}

export function optionalIdentifier(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredIdentifier(value, field);
}

/** Free text is length-capped; adapters must still bind it as a parameter. */
export function optionalSearchTerm(
  value: unknown,
  field = 'search',
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') invalid(field);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 256) invalid(field);
  // Control characters never appear in stored telemetry text; reject them early.
  if (hasControlCharacter(trimmed)) invalid(field);
  return trimmed;
}

export function optionalSeverities(
  value: unknown,
  field = 'severity',
): readonly LogSeverity[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const values = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    typeof entry === 'string' ? entry.split(',') : [invalid(field)],
  );
  const severities = [
    ...new Set(values.map((entry) => entry.trim().toLowerCase())),
  ].filter(Boolean);
  if (!severities.length) return undefined;
  for (const severity of severities)
    if (!severitySet.has(severity)) invalid(field);
  return severities as LogSeverity[];
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T))
    invalid(field);
  return value as T;
}

export function parseLimit(
  value: unknown,
  limits: TelemetryQueryLimits,
): number {
  if (value === undefined || value === null || value === '')
    return limits.defaultLimit;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) invalid('limit');
  // Clamp rather than reject: an oversized page request still gets bounded data.
  return Math.min(limit, limits.maxLimit);
}

export interface ParsedTimeRange {
  startTime: string;
  endTime: string;
  durationMs: number;
}

/**
 * A bounded window is mandatory. Callers must pass both ends: defaulting to
 * "the last hour" would silently hide the fact that a query was narrowed.
 */
export function parseTimeRange(
  start: unknown,
  end: unknown,
  maxRangeMs: number,
): ParsedTimeRange {
  if (typeof start !== 'string' || !start)
    throw new TelemetryQueryError('startTime is required');
  if (typeof end !== 'string' || !end)
    throw new TelemetryQueryError('endTime is required');
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs)) invalid('startTime');
  if (!Number.isFinite(endMs)) invalid('endTime');
  if (endMs <= startMs)
    throw new TelemetryQueryError('endTime must be after startTime');
  const durationMs = endMs - startMs;
  if (durationMs > maxRangeMs)
    throw new TelemetryQueryError(
      `Time range exceeds the maximum of ${maxRangeMs} ms`,
    );
  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    durationMs,
  };
}

export interface RawLogSearchInput {
  clusterId?: unknown;
  namespace?: unknown;
  workload?: unknown;
  pod?: unknown;
  container?: unknown;
  node?: unknown;
  severity?: unknown;
  search?: unknown;
  traceId?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export function validateLogSearchQuery(
  input: RawLogSearchInput,
  limits: TelemetryQueryLimits = defaultQueryLimits,
): LogSearchQuery {
  const range = parseTimeRange(
    input.startTime,
    input.endTime,
    limits.maxTimeRangeMs,
  );
  const cursor = decodeTelemetryCursor(
    input.cursor === '' ? undefined : input.cursor,
  );
  const severity = optionalSeverities(input.severity);
  const search = optionalSearchTerm(input.search);
  const traceId = optionalIdentifier(input.traceId, 'traceId');
  return {
    clusterId: requiredIdentifier(input.clusterId, 'clusterId'),
    ...optionalScopeFilters(input),
    ...(severity ? { severity } : {}),
    ...(search ? { search } : {}),
    ...(traceId ? { traceId } : {}),
    startTime: range.startTime,
    endTime: range.endTime,
    limit: parseLimit(input.limit, limits),
    ...(cursor ? { cursor: input.cursor as string } : {}),
  };
}

function optionalScopeFilters(input: {
  namespace?: unknown;
  workload?: unknown;
  pod?: unknown;
  container?: unknown;
  node?: unknown;
}): Partial<
  Pick<LogSearchQuery, 'namespace' | 'workload' | 'pod' | 'container' | 'node'>
> {
  const namespace = optionalIdentifier(input.namespace, 'namespace');
  const workload = optionalIdentifier(input.workload, 'workload');
  const pod = optionalIdentifier(input.pod, 'pod');
  const container = optionalIdentifier(input.container, 'container');
  const node = optionalIdentifier(input.node, 'node');
  return {
    ...(namespace ? { namespace } : {}),
    ...(workload ? { workload } : {}),
    ...(pod ? { pod } : {}),
    ...(container ? { container } : {}),
    ...(node ? { node } : {}),
  };
}

export interface RawMetricQueryInput {
  clusterId?: unknown;
  metricName?: unknown;
  namespace?: unknown;
  workload?: unknown;
  pod?: unknown;
  container?: unknown;
  node?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  bucket?: unknown;
  aggregations?: unknown;
  limit?: unknown;
}

export function validateMetricQuery(
  input: RawMetricQueryInput,
  limits: TelemetryQueryLimits = defaultQueryLimits,
): MetricQuery {
  const range = parseTimeRange(
    input.startTime,
    input.endTime,
    limits.maxMetricTimeRangeMs,
  );
  const bucketMs = parseBucketMs(input.bucket, range.durationMs, limits);
  return {
    clusterId: requiredIdentifier(input.clusterId, 'clusterId'),
    metricName: requiredIdentifier(input.metricName, 'metricName'),
    ...optionalScopeFilters(input),
    startTime: range.startTime,
    endTime: range.endTime,
    bucketMs,
    aggregations: parseAggregations(input.aggregations),
    limit: Math.min(parseLimit(input.limit, limits), limits.maxBuckets),
  };
}

function parseBucketMs(
  value: unknown,
  durationMs: number,
  limits: TelemetryQueryLimits,
): number {
  const bucketMs =
    value === undefined || value === null || value === ''
      ? Math.max(
          limits.minBucketMs,
          Math.ceil(durationMs / 60 / limits.minBucketMs) * limits.minBucketMs,
        )
      : Number(value);
  if (!Number.isSafeInteger(bucketMs) || bucketMs < limits.minBucketMs)
    invalid('bucket');
  if (durationMs / bucketMs > limits.maxBuckets)
    throw new TelemetryQueryError(
      `Bucket produces more than ${limits.maxBuckets} points; widen the bucket or narrow the range`,
    );
  return bucketMs;
}

function parseAggregations(value: unknown): readonly MetricAggregation[] {
  if (value === undefined || value === null || value === '')
    return ['min', 'max', 'avg', 'count'];
  const values = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    typeof entry === 'string' ? entry.split(',') : [invalid('aggregations')],
  );
  const aggregations = [
    ...new Set(values.map((entry) => entry.trim().toLowerCase())),
  ].filter(Boolean);
  if (!aggregations.length) invalid('aggregations');
  for (const aggregation of aggregations)
    if (!aggregationSet.has(aggregation)) invalid('aggregations');
  return aggregations as MetricAggregation[];
}

export interface RawKubernetesEventQueryInput {
  clusterId?: unknown;
  namespace?: unknown;
  workload?: unknown;
  pod?: unknown;
  node?: unknown;
  reason?: unknown;
  type?: unknown;
  resourceName?: unknown;
  resourceKind?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export function validateKubernetesEventQuery(
  input: RawKubernetesEventQueryInput,
  limits: TelemetryQueryLimits = defaultQueryLimits,
): KubernetesEventQuery {
  const range = parseTimeRange(
    input.startTime,
    input.endTime,
    limits.maxTimeRangeMs,
  );
  const cursor = decodeTelemetryCursor(
    input.cursor === '' ? undefined : input.cursor,
  );
  const reason = optionalIdentifier(input.reason, 'reason');
  const resourceName = optionalIdentifier(input.resourceName, 'resourceName');
  const resourceKind = optionalIdentifier(input.resourceKind, 'resourceKind');
  const scope = optionalScopeFilters(input);
  const type = optionalEnum(input.type, ['Normal', 'Warning'] as const, 'type');
  return {
    clusterId: requiredIdentifier(input.clusterId, 'clusterId'),
    ...(scope.namespace ? { namespace: scope.namespace } : {}),
    ...(scope.workload ? { workload: scope.workload } : {}),
    ...(scope.pod ? { pod: scope.pod } : {}),
    ...(scope.node ? { node: scope.node } : {}),
    ...(reason ? { reason } : {}),
    ...(type ? { type } : {}),
    ...(resourceName ? { resourceName } : {}),
    ...(resourceKind ? { resourceKind } : {}),
    startTime: range.startTime,
    endTime: range.endTime,
    limit: parseLimit(input.limit, limits),
    ...(cursor ? { cursor: input.cursor as string } : {}),
  };
}

export interface RawResourceTimelineInput {
  resourceId?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  limit?: unknown;
  severity?: unknown;
  metricNames?: unknown;
}

/** Metric samples included in a timeline unless the caller narrows them. */
export const defaultTimelineMetricNames: readonly string[] = [
  'k8s.container.memory.usage',
  'k8s.container.memory.limit',
  'k8s.container.cpu.usage',
  'k8s.container.restart_count',
];

export function validateResourceTimelineQuery(
  input: RawResourceTimelineInput,
  limits: TelemetryQueryLimits = defaultQueryLimits,
): ResourceTimelineQuery {
  const resource = parseTelemetryResourceId(input.resourceId);
  if (!resource) throw new TelemetryQueryError('Invalid resource identifier');
  requiredIdentifier(resource.clusterId, 'resourceId');
  const range = parseTimeRange(
    input.startTime,
    input.endTime,
    limits.maxTimeRangeMs,
  );
  const severity = optionalSeverities(input.severity);
  return {
    resource,
    startTime: range.startTime,
    endTime: range.endTime,
    limit: parseLimit(input.limit, limits),
    ...(severity ? { severity } : {}),
    metricNames: parseMetricNames(input.metricNames),
  };
}

function parseMetricNames(value: unknown): readonly string[] {
  if (value === undefined || value === null || value === '')
    return defaultTimelineMetricNames;
  const values = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    typeof entry === 'string' ? entry.split(',') : [invalid('metricNames')],
  );
  const names = [...new Set(values.map((entry) => entry.trim()))].filter(
    Boolean,
  );
  if (names.length > 16) invalid('metricNames');
  return names.map((name) => requiredIdentifier(name, 'metricNames'));
}

/** Timeline filters for the resource reference, shared by every adapter. */
export function resourceTimelineFilters(resource: TelemetryResourceRef): {
  namespace?: string;
  workload?: string;
  pod?: string;
  container?: string;
  node?: string;
} {
  switch (resource.scope) {
    case 'container':
      return {
        namespace: resource.namespace!,
        pod: resource.name,
        container: resource.container!,
      };
    case 'pod':
      return { namespace: resource.namespace!, pod: resource.name };
    case 'workload':
      return {
        ...(resource.namespace ? { namespace: resource.namespace } : {}),
        workload: resource.name,
      };
    case 'node':
      return { node: resource.name };
    case 'namespace':
      return { namespace: resource.name };
  }
}

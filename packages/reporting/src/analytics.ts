import type {
  IncidentClassification,
  IncidentSeverity,
  IncidentStatus,
} from '@faultline/incidents';

export interface AnalyticsDateRange {
  from?: Date;
  to?: Date;
}

export const incidentTrendBuckets = ['hour', 'day', 'week', 'month'] as const;
export type IncidentTrendBucket = (typeof incidentTrendBuckets)[number];

export interface IncidentTrendInput {
  from: Date;
  to: Date;
  bucket: IncidentTrendBucket;
}

export interface IncidentTrendPoint {
  /** Inclusive UTC start of the bucket, formatted as an ISO-8601 instant. */
  timestamp: string;
  total: number;
  critical: number;
  resolved: number;
}

export interface IncidentTrends {
  bucket: IncidentTrendBucket;
  points: readonly IncidentTrendPoint[];
}

/** Minimal normalized projection required for incident metrics. */
export interface IncidentMetricRecord {
  id: string;
  classification: IncidentClassification;
  severity: IncidentSeverity;
  status: IncidentStatus;
  detectedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  affectedServices: readonly string[];
}

export interface IncidentAnalyticsRepository {
  listIncidentMetricRecords(
    range: AnalyticsDateRange,
  ): Promise<readonly IncidentMetricRecord[]>;
  getIncidentTrendPoints(
    input: IncidentTrendInput,
  ): Promise<readonly IncidentTrendPoint[]>;
}

export const INCIDENT_ANALYTICS_REPOSITORY = Symbol(
  'faultline.incident-analytics-repository',
);

export interface IncidentAnalyticsMetrics {
  range: { from: string | null; to: string | null };
  totalIncidents: number;
  openIncidents: number;
  resolvedIncidents: number;
  criticalIncidents: number;
  incidentsBySeverity: Readonly<Partial<Record<IncidentSeverity, number>>>;
  incidentsByStatus: Readonly<Partial<Record<IncidentStatus, number>>>;
  incidentsByClassification: Readonly<
    Partial<Record<IncidentClassification, number>>
  >;
  incidentsByService: Readonly<Record<string, number>>;
  resolutionRate: number;
  mttrMs: number | null;
  mttaMs: number | null;
}

/** Calculates incident metrics from one repository projection, independent of storage. */
export class AnalyticsService {
  constructor(private readonly repository: IncidentAnalyticsRepository) {}

  async getIncidentMetrics(
    range: AnalyticsDateRange = {},
  ): Promise<IncidentAnalyticsMetrics> {
    validateRange(range);
    const records = await this.repository.listIncidentMetricRecords(range);
    const resolved = records.filter((record) => record.status === 'RESOLVED');
    const resolutionTimes = resolved
      .map((record) => elapsed(record.detectedAt, record.resolvedAt))
      .filter((value): value is number => value !== undefined);
    const acknowledgementTimes = records
      .map((record) => elapsed(record.detectedAt, record.acknowledgedAt))
      .filter((value): value is number => value !== undefined);

    return {
      range: {
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
      },
      totalIncidents: records.length,
      openIncidents: records.length - resolved.length,
      resolvedIncidents: resolved.length,
      criticalIncidents: records.filter(
        (record) => record.severity === 'CRITICAL',
      ).length,
      incidentsBySeverity: countBy(records, (record) => record.severity),
      incidentsByStatus: countBy(records, (record) => record.status),
      incidentsByClassification: countBy(
        records,
        (record) => record.classification,
      ),
      incidentsByService: countServices(records),
      resolutionRate: records.length ? resolved.length / records.length : 0,
      mttrMs: mean(resolutionTimes),
      mttaMs: mean(acknowledgementTimes),
    };
  }

  async getIncidentTrends(input: IncidentTrendInput): Promise<IncidentTrends> {
    validateRange(input);
    if (!(incidentTrendBuckets as readonly unknown[]).includes(input.bucket))
      throw new RangeError('Invalid incident trend bucket');
    return {
      bucket: input.bucket,
      points: await this.repository.getIncidentTrendPoints(input),
    };
  }
}

function validateRange(range: AnalyticsDateRange): void {
  if (range.from && !Number.isFinite(range.from.getTime()))
    throw new RangeError('Invalid analytics from date');
  if (range.to && !Number.isFinite(range.to.getTime()))
    throw new RangeError('Invalid analytics to date');
  if (range.from && range.to && range.from > range.to)
    throw new RangeError('Analytics from date must not be after to date');
}

function elapsed(start: string, end: string | null): number | undefined {
  if (!end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return undefined;
  return endMs - startMs;
}

function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countBy<T, K extends string>(
  values: readonly T[],
  key: (value: T) => K,
): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function countServices(
  records: readonly IncidentMetricRecord[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const record of records)
    for (const service of new Set(record.affectedServices))
      counts[service] = (counts[service] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

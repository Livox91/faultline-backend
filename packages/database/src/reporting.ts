import type { QueryResultRow } from 'pg';
import type {
  AnalyticsDateRange,
  IncidentAnalyticsRepository,
  IncidentMetricRecord,
  IncidentTrendBucket,
  IncidentTrendInput,
  IncidentTrendPoint,
} from '@faultline/reporting';
import type {
  IncidentClassification,
  IncidentSeverity,
  IncidentStatus,
} from '@faultline/incidents';
import type { PostgresConnection } from './index';

interface MetricRow extends QueryResultRow {
  id: string;
  classification: string;
  severity: string;
  status: string;
  detected_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  affected_services: string[];
}

interface TrendRow extends QueryResultRow {
  bucket_start_ms: string;
  total: string;
  critical: string;
  resolved: string;
}

const trendBuckets = new Set<IncidentTrendBucket>([
  'hour',
  'day',
  'week',
  'month',
]);

/** One bounded query; acknowledgement and service data never require per-incident reads. */
export class PostgresIncidentAnalyticsRepository
  implements IncidentAnalyticsRepository
{
  constructor(private readonly connection: PostgresConnection) {}

  async listIncidentMetricRecords(
    range: AnalyticsDateRange,
  ): Promise<readonly IncidentMetricRecord[]> {
    const result = await this.connection.pool.query<MetricRow>(
      `SELECT i.id::text,
              i.classification,
              i.severity,
              i.status,
              i.first_seen AS detected_at,
              CASE
                WHEN a.aggregate->>'acknowledgedAt' IS NULL THEN NULL
                ELSE (a.aggregate->>'acknowledgedAt')::timestamptz
              END AS acknowledged_at,
              i.resolved_at,
              ARRAY(
                SELECT DISTINCT service
                FROM (
                  SELECT NULLIF(i.aggregate->>'logicalService', '') AS service
                  UNION ALL
                  SELECT NULLIF(resource->>'workload', '') AS service
                  FROM jsonb_array_elements(
                    COALESCE(i.aggregate->'affectedResources', '[]'::jsonb)
                  ) AS resource
                ) services
                WHERE service IS NOT NULL
                ORDER BY service
              ) AS affected_services
       FROM incidents i
       LEFT JOIN incident_acknowledgements a ON a.incident_id = i.id::text
       WHERE ($1::timestamptz IS NULL OR i.first_seen >= $1)
         AND ($2::timestamptz IS NULL OR i.first_seen < $2)
       ORDER BY i.first_seen, i.id`,
      [range.from?.toISOString() ?? null, range.to?.toISOString() ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      classification: row.classification as IncidentClassification,
      severity: row.severity as IncidentSeverity,
      status: row.status as IncidentStatus,
      detectedAt: row.detected_at.toISOString(),
      acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      affectedServices: row.affected_services,
    }));
  }

  async getIncidentTrendPoints(
    input: IncidentTrendInput,
  ): Promise<readonly IncidentTrendPoint[]> {
    if (!trendBuckets.has(input.bucket))
      throw new RangeError('Invalid incident trend bucket');
    const result = await this.connection.pool.query<TrendRow>(
      `SELECT (
                EXTRACT(EPOCH FROM (
                  date_trunc($3, i.first_seen AT TIME ZONE 'UTC')
                  AT TIME ZONE 'UTC'
                )) * 1000
              )::bigint::text AS bucket_start_ms,
              count(*)::text AS total,
              count(*) FILTER (WHERE i.severity = $4)::text AS critical,
              count(*) FILTER (WHERE i.status = $5)::text AS resolved
       FROM incidents i
       WHERE i.first_seen >= $1
         AND i.first_seen < $2
       GROUP BY date_trunc($3, i.first_seen AT TIME ZONE 'UTC')
       ORDER BY date_trunc($3, i.first_seen AT TIME ZONE 'UTC')`,
      [
        input.from.toISOString(),
        input.to.toISOString(),
        input.bucket,
        'CRITICAL' satisfies IncidentSeverity,
        'RESOLVED' satisfies IncidentStatus,
      ],
    );
    return result.rows.map((row) => ({
      timestamp: new Date(Number(row.bucket_start_ms)).toISOString(),
      total: Number(row.total),
      critical: Number(row.critical),
      resolved: Number(row.resolved),
    }));
  }
}

import type { QueryResultRow } from 'pg';
import {
  decodeSeason,
  encodeSeason,
  type BaselineFilter,
  type BaselineKey,
  type BaselineRepository,
  type BaselineResourceType,
  type BaselineStatistics,
  type BaselineStatus,
  type BaselineWindow,
  type BaselineWorkloadRef,
  type MetricBaseline,
} from '@faultline/baselines';
import type { PostgresConnection } from './index';

interface BaselineRow extends QueryResultRow {
  cluster_id: string;
  namespace: string;
  workload: string;
  resource_type: string;
  metric_name: string;
  window_name: string;
  season: string;
  status: string;
  sample_count: string;
  unit: string | null;
  window_start: Date;
  window_end: Date;
  excluded_ranges: number;
  statistics: BaselineStatistics | null;
  updated_at: Date;
}

/**
 * PostgreSQL adapter for derived baselines.
 *
 * Baselines are control-plane state, not telemetry: one small row per workload, metric
 * and window, recomputable from ClickHouse at any time. Keeping them here is what lets
 * the processor go on detecting deviations while the telemetry store is unavailable.
 */
export class PostgresBaselineRepository implements BaselineRepository {
  constructor(private readonly connection: PostgresConnection) {}

  /**
   * One statement per refresh cycle.
   *
   * Refresh recomputes a whole workload at once, so the batch is written with a single
   * multi-row upsert rather than a statement per baseline.
   */
  async save(baselines: readonly MetricBaseline[]): Promise<void> {
    if (!baselines.length) return;
    const clusters = [...new Set(baselines.map((item) => item.clusterId))];
    const values: unknown[] = [];
    const tuples = baselines.map((baseline) => {
      values.push(
        baseline.clusterId,
        baseline.namespace,
        baseline.workload,
        baseline.resourceType,
        baseline.metricName,
        baseline.window,
        encodeSeason(baseline.season),
        baseline.status,
        baseline.sampleCount,
        baseline.unit ?? null,
        baseline.windowStart,
        baseline.windowEnd,
        baseline.excludedRanges,
        baseline.statistics ? JSON.stringify(baseline.statistics) : null,
        baseline.updatedAt,
      );
      const start = values.length - 15;
      return `(${Array.from({ length: 15 }, (_unused, index) => `$${start + index + 1}`).join(',')})`;
    });
    const client = await this.connection.pool.connect();
    try {
      await client.query('BEGIN');
      // The foreign key exists so a baseline can never outlive its cluster row.
      await client.query(
        'INSERT INTO clusters (id) SELECT unnest($1::text[]) ON CONFLICT (id) DO NOTHING',
        [clusters],
      );
      await client.query(
        `INSERT INTO metric_baselines
           (cluster_id, namespace, workload, resource_type, metric_name, window_name, season,
            status, sample_count, unit, window_start, window_end, excluded_ranges, statistics, updated_at)
         VALUES ${tuples.join(',')}
         ON CONFLICT (cluster_id, namespace, workload, resource_type, metric_name, window_name, season)
         DO UPDATE SET status=EXCLUDED.status, sample_count=EXCLUDED.sample_count, unit=EXCLUDED.unit,
           window_start=EXCLUDED.window_start, window_end=EXCLUDED.window_end,
           excluded_ranges=EXCLUDED.excluded_ranges, statistics=EXCLUDED.statistics,
           updated_at=EXCLUDED.updated_at`,
        values,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(key: BaselineKey): Promise<MetricBaseline | undefined> {
    const result = await this.connection.pool.query<BaselineRow>(
      `SELECT * FROM metric_baselines WHERE cluster_id=$1 AND namespace=$2 AND workload=$3
         AND resource_type=$4 AND metric_name=$5 AND window_name=$6 AND season=$7`,
      [
        key.clusterId,
        key.namespace,
        key.workload,
        key.resourceType,
        key.metricName,
        key.window,
        encodeSeason(key.season),
      ],
    );
    const row = result.rows[0];
    return row ? toBaseline(row) : undefined;
  }

  async listForWorkload(
    workload: BaselineWorkloadRef,
  ): Promise<readonly MetricBaseline[]> {
    const result = await this.connection.pool.query<BaselineRow>(
      'SELECT * FROM metric_baselines WHERE cluster_id=$1 AND namespace=$2 AND workload=$3',
      [workload.clusterId, workload.namespace, workload.workload],
    );
    return result.rows.map(toBaseline);
  }

  async list(filter: BaselineFilter = {}): Promise<readonly MetricBaseline[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (filter.clusterIds?.length) {
      values.push([...filter.clusterIds]);
      clauses.push(`cluster_id = ANY($${values.length})`);
    }
    for (const [column, value] of [
      ['cluster_id', filter.clusterId],
      ['namespace', filter.namespace],
      ['workload', filter.workload],
      ['metric_name', filter.metricName],
      ['window_name', filter.window],
      ['status', filter.status],
    ] as const)
      if (value) {
        values.push(value);
        clauses.push(`${column}=$${values.length}`);
      }
    values.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const result = await this.connection.pool.query<BaselineRow>(
      `SELECT * FROM metric_baselines${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}
       ORDER BY cluster_id, namespace, workload, metric_name LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toBaseline);
  }

  async deleteStale(before: string): Promise<number> {
    const result = await this.connection.pool.query(
      'DELETE FROM metric_baselines WHERE updated_at < $1',
      [before],
    );
    return result.rowCount ?? 0;
  }
}

function toBaseline(row: BaselineRow): MetricBaseline {
  return {
    clusterId: row.cluster_id,
    namespace: row.namespace,
    workload: row.workload,
    resourceType: row.resource_type as BaselineResourceType,
    metricName: row.metric_name,
    window: row.window_name as BaselineWindow,
    season: decodeSeason(row.season) ?? { kind: 'all' },
    status: row.status as BaselineStatus,
    ...(row.statistics ? { statistics: row.statistics } : {}),
    sampleCount: Number(row.sample_count),
    ...(row.unit ? { unit: row.unit } : {}),
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    excludedRanges: row.excluded_ranges,
    updatedAt: row.updated_at.toISOString(),
  };
}

import type {
  BaselineTarget,
  BaselineTargetRequest,
  DisruptionWindowRequest,
  HistoricalTelemetryQuery,
  MetricSummary,
  MetricSummaryRequest,
  TimeRange,
} from '@faultline/baselines';
import type { ClickHouseConnection } from './connection';
import { quoteIdentifier } from './schema';

/**
 * ClickHouse implementation of the baseline engine's read port.
 *
 * Every summary is computed inside ClickHouse - quantiles, standard deviation and
 * per-bucket rates alike. Shipping a day of raw samples to Node just to average them
 * would be slower by orders of magnitude and would put the size of a workload's history
 * into the process's memory budget.
 *
 * As with the telemetry store, caller input only ever arrives as a bound `query_params`
 * value: this class writes all the SQL there is.
 */
export class ClickHouseHistoricalTelemetry implements HistoricalTelemetryQuery {
  readonly name = 'clickhouse-historical-telemetry';

  constructor(
    private readonly connection: ClickHouseConnection,
    private readonly queryTimeoutMs = 60_000,
  ) {}

  /**
   * Workloads that reported telemetry recently.
   *
   * Baselines are only worth computing for workloads that still exist, so discovery runs
   * over a short recent window rather than the full baseline window.
   */
  async listBaselineTargets(
    request: BaselineTargetRequest,
  ): Promise<readonly BaselineTarget[]> {
    const rows = await this.run<{
      cluster_id: string;
      namespace: string;
      workload: string;
    }>(
      `SELECT cluster_id, namespace, workload
       FROM ${this.table('telemetry_metrics')}
       WHERE ${this.rangeClause()}
         AND metric_name IN {metricNames:Array(String)}
         AND namespace != '' AND workload != ''
         ${request.clusterIds?.length ? 'AND cluster_id IN {clusterIds:Array(String)}' : ''}
       GROUP BY cluster_id, namespace, workload
       ORDER BY cluster_id, namespace, workload
       LIMIT {limit:UInt32}`,
      {
        ...this.rangeParams(request.window),
        metricNames: [...request.metricNames],
        ...(request.clusterIds?.length
          ? { clusterIds: [...request.clusterIds] }
          : {}),
        limit: request.limit,
      },
    );
    return rows.map((row) => ({
      clusterId: row.cluster_id,
      namespace: row.namespace,
      workload: row.workload,
    }));
  }

  async summarizeMetric(request: MetricSummaryRequest): Promise<MetricSummary> {
    const { sql, params } = this.summaryQuery(request);
    const rows = await this.run<SummaryRow>(sql, params);
    const row = rows[0];
    const sampleCount = Number(row?.sample_count ?? 0);
    if (!row || sampleCount === 0) return { sampleCount: 0 };
    return {
      sampleCount,
      ...(row.unit ? { unit: row.unit } : {}),
      statistics: {
        sampleCount,
        mean: Number(row.mean),
        min: Number(row.min_value),
        max: Number(row.max_value),
        standardDeviation: Number(row.std_dev),
        p50: Number(row.p50),
        p95: Number(row.p95),
        p99: Number(row.p99),
      },
    };
  }

  /**
   * Stretches where the workload was demonstrably unhealthy.
   *
   * Each matching warning event becomes a padded range. The engine merges them before
   * use, so a crash loop producing hundreds of BackOff events costs one exclusion range
   * rather than hundreds.
   */
  async findDisruptionWindows(
    request: DisruptionWindowRequest,
  ): Promise<readonly TimeRange[]> {
    const rows = await this.run<{ start_ms: string; end_ms: string }>(
      `SELECT
         toUnixTimestamp64Milli(min(event_timestamp)) - {paddingMs:Int64} AS start_ms,
         toUnixTimestamp64Milli(max(event_timestamp)) + {paddingMs:Int64} AS end_ms
       FROM ${this.table('telemetry_kubernetes_events')}
       WHERE ${this.rangeClause()}
         AND cluster_id = {clusterId:String}
         AND namespace = {namespace:String}
         AND (workload = {workload:String} OR startsWith(resource_name, concat({workload:String}, '-')))
         AND reason IN {reasons:Array(String)}
       GROUP BY intDiv(toUnixTimestamp64Milli(event_timestamp), {paddingMs:Int64})
       ORDER BY start_ms
       LIMIT {limit:UInt32}`,
      {
        ...this.rangeParams(request.window),
        clusterId: request.clusterId,
        namespace: request.namespace,
        workload: request.workload,
        reasons: [...request.reasons],
        // Grouping by padding-sized slots collapses event storms before they leave the
        // server; zero padding would divide by zero, so a one-second floor applies.
        paddingMs: Math.max(1000, request.paddingMs),
        limit: request.limit,
      },
    );
    return rows.map((row) => ({
      startTime: new Date(Number(row.start_ms)).toISOString(),
      endTime: new Date(Number(row.end_ms)).toISOString(),
    }));
  }

  /**
   * Builds the summary statement for one signal shape.
   *
   * Gauges summarize raw samples directly. Counters, ratios and error rates are reduced
   * to one value per bucket first and summarized over those, so the baseline always
   * describes the same quantity the detector computes from live telemetry.
   */
  private summaryQuery(request: MetricSummaryRequest): {
    sql: string;
    params: Record<string, unknown>;
  } {
    const scope = {
      ...this.rangeParams(request.window),
      clusterId: request.clusterId,
      namespace: request.namespace,
      workload: request.workload,
      maxSamples: request.maxSamples,
    };
    const exclusion = this.exclusionClause(request.exclude);
    const where = `${this.rangeClause()}
         AND cluster_id = {clusterId:String}
         AND namespace = {namespace:String}
         AND workload = {workload:String}${exclusion.clause}`;
    const statistics = `count() AS sample_count,
       avg(value) AS mean, min(value) AS min_value, max(value) AS max_value,
       stddevPop(value) AS std_dev,
       quantileExact(0.5)(value) AS p50,
       quantileExact(0.95)(value) AS p95,
       quantileExact(0.99)(value) AS p99`;

    if (request.source.kind === 'gauge') {
      const attributes = this.attributeClause(request.source.attributes);
      return {
        sql: `SELECT ${statistics}, any(unit) AS unit
              FROM (
                SELECT value, unit FROM ${this.table('telemetry_metrics')}
                WHERE ${where} AND metric_name = {metricName:String}${attributes.clause}
                LIMIT {maxSamples:UInt64}
              )`,
        params: {
          ...scope,
          ...exclusion.params,
          ...attributes.params,
          metricName: request.source.metricName,
        },
      };
    }

    if (request.source.kind === 'counter-rate') {
      const attributes = this.attributeClause(request.source.attributes);
      return {
        // A negative bucket delta means the counter restarted, so the bucket's own
        // maximum is used: the work still happened, it simply began from zero again.
        sql: `SELECT ${statistics}
              FROM (
                SELECT
                  if(max(value) >= min(value), max(value) - min(value), greatest(max(value), 0))
                    / ({bucketMs:Int64} / 1000) * {perSeconds:Float64} AS value
                FROM ${this.table('telemetry_metrics')}
                WHERE ${where} AND metric_name = {metricName:String}${attributes.clause}
                GROUP BY intDiv(toUnixTimestamp64Milli(event_timestamp), {bucketMs:Int64}), pod, container
                LIMIT {maxSamples:UInt64}
              )`,
        params: {
          ...scope,
          ...exclusion.params,
          ...attributes.params,
          metricName: request.source.metricName,
          bucketMs: request.bucketMs,
          perSeconds: request.source.perSeconds,
        },
      };
    }

    if (request.source.kind === 'ratio') {
      const numerator = this.attributeClause(
        request.source.numerator.attributes,
        'num',
      );
      const denominator = this.attributeClause(
        request.source.denominator.attributes,
        'den',
      );
      return {
        // Both metrics are read in one pass and divided per bucket and container, which
        // is how memory utilization is derived without storing it as its own metric.
        sql: `SELECT ${statistics}
              FROM (
                SELECT
                  avgIf(value, metric_name = {numeratorMetric:String}${numerator.clause})
                    / nullIf(maxIf(value, metric_name = {denominatorMetric:String}${denominator.clause}), 0)
                    * {scale:Float64} AS value
                FROM ${this.table('telemetry_metrics')}
                WHERE ${where}
                  AND metric_name IN ({numeratorMetric:String}, {denominatorMetric:String})
                GROUP BY intDiv(toUnixTimestamp64Milli(event_timestamp), {bucketMs:Int64}), pod, container
                HAVING isNotNull(value) AND isFinite(value)
                LIMIT {maxSamples:UInt64}
              )`,
        params: {
          ...scope,
          ...exclusion.params,
          ...numerator.params,
          ...denominator.params,
          numeratorMetric: request.source.numerator.metricName,
          denominatorMetric: request.source.denominator.metricName,
          bucketMs: request.bucketMs,
          scale: request.source.scale,
        },
      };
    }

    return {
      // Error rate is the share of a bucket's logs that were errors, not a raw count:
      // a workload that simply logs more must not read as a workload that is failing.
      sql: `SELECT ${statistics}
            FROM (
              SELECT countIf(severity IN {severities:Array(String)}) / count() * {scale:Float64} AS value
              FROM ${this.table('telemetry_logs')}
              WHERE ${where}
              GROUP BY intDiv(toUnixTimestamp64Milli(event_timestamp), {bucketMs:Int64})
              LIMIT {maxSamples:UInt64}
            )`,
      params: {
        ...scope,
        ...exclusion.params,
        severities: [...request.source.severities],
        bucketMs: request.bucketMs,
        scale: request.source.scale,
      },
    };
  }

  private attributeClause(
    attributes: Readonly<Record<string, string>> | undefined,
    prefix = 'attr',
  ): { clause: string; params: Record<string, unknown> } {
    if (!attributes) return { clause: '', params: {} };
    const params: Record<string, unknown> = {};
    const clauses = Object.entries(attributes).map(([key, value], index) => {
      params[`${prefix}Key${index}`] = key;
      params[`${prefix}Value${index}`] = value;
      return ` AND attributes[{${prefix}Key${index}:String}] = {${prefix}Value${index}:String}`;
    });
    return { clause: clauses.join(''), params };
  }

  private exclusionClause(exclude: readonly TimeRange[]): {
    clause: string;
    params: Record<string, unknown>;
  } {
    if (!exclude.length) return { clause: '', params: {} };
    const params: Record<string, unknown> = {};
    const clauses = exclude.map((range, index) => {
      params[`exStart${index}`] = Date.parse(range.startTime);
      params[`exEnd${index}`] = Date.parse(range.endTime);
      return ` AND NOT (event_timestamp >= fromUnixTimestamp64Milli({exStart${index}:Int64}, 'UTC') AND event_timestamp < fromUnixTimestamp64Milli({exEnd${index}:Int64}, 'UTC'))`;
    });
    return { clause: clauses.join(''), params };
  }

  private rangeClause(): string {
    return `event_timestamp >= fromUnixTimestamp64Milli({startMs:Int64}, 'UTC')
         AND event_timestamp < fromUnixTimestamp64Milli({endMs:Int64}, 'UTC')`;
  }

  private rangeParams(window: TimeRange): Record<string, unknown> {
    return {
      startMs: Date.parse(window.startTime),
      endMs: Date.parse(window.endTime),
    };
  }

  private table(name: string): string {
    return `${quoteIdentifier(this.connection.options.database)}.${name}`;
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
        // Baseline refresh reads far more history than an interactive query, so it gets
        // its own, longer ceiling rather than borrowing the API's.
        max_execution_time: Math.max(
          1,
          Math.ceil(this.queryTimeoutMs / 1000),
        ),
        timeout_overflow_mode: 'throw',
      },
      abort_signal: AbortSignal.timeout(this.queryTimeoutMs),
    });
    return result.json<T>();
  }
}

interface SummaryRow {
  sample_count: string;
  mean: number;
  min_value: number;
  max_value: number;
  std_dev: number;
  p50: number;
  p95: number;
  p99: number;
  unit?: string;
}

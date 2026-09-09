import type { BaselineStatistics } from './baseline';
import type { BaselineMetricSource } from './catalog';

/**
 * The read side the baseline engine needs from telemetry history.
 *
 * Deliberately narrow and statistics-shaped: it returns distributions, never raw
 * samples. That keeps the aggregation in the store that is good at it, keeps megabytes
 * of history out of the process computing baselines, and - most importantly - keeps the
 * baseline and detection code free of any ClickHouse type.
 */
export const HISTORICAL_TELEMETRY_QUERY = Symbol(
  'faultline.historical-telemetry-query',
);

export interface TimeRange {
  startTime: string;
  endTime: string;
}

/** One workload that reported a signal recently, and is therefore worth baselining. */
export interface BaselineTarget {
  clusterId: string;
  namespace: string;
  workload: string;
}

export interface BaselineTargetRequest {
  clusterIds?: readonly string[];
  /** Metric names that identify an active workload; logs are covered separately. */
  metricNames: readonly string[];
  window: TimeRange;
  limit: number;
}

export interface MetricSummaryRequest {
  clusterId: string;
  namespace: string;
  workload: string;
  source: BaselineMetricSource;
  window: TimeRange;
  /**
   * Bucket width for counter rates, ratios and error rates. Raw gauges are summarized
   * over individual samples, so this only shapes the derived signals.
   */
  bucketMs: number;
  /** Ranges to leave out; see `BaselineEngine` for why baselines exclude them. */
  exclude: readonly TimeRange[];
  /** Server-side row ceiling, mirroring the telemetry query safety limits. */
  maxSamples: number;
}

export interface MetricSummary {
  statistics?: BaselineStatistics;
  sampleCount: number;
  unit?: string;
}

/**
 * Periods that should not teach Faultline what "normal" looks like.
 *
 * Returned by the history port because the evidence lives beside the telemetry: warning
 * events such as OOMKilling, BackOff and Evicted mark stretches where the workload was
 * demonstrably unhealthy.
 */
export interface DisruptionWindowRequest {
  clusterId: string;
  namespace: string;
  workload: string;
  window: TimeRange;
  /** Kubernetes event reasons that mark a disrupted period. */
  reasons: readonly string[];
  /** Padding applied either side of each event. */
  paddingMs: number;
  limit: number;
}

export interface HistoricalTelemetryQuery {
  listBaselineTargets(
    request: BaselineTargetRequest,
  ): Promise<readonly BaselineTarget[]>;
  summarizeMetric(request: MetricSummaryRequest): Promise<MetricSummary>;
  findDisruptionWindows(
    request: DisruptionWindowRequest,
  ): Promise<readonly TimeRange[]>;
}

/** Merges overlapping ranges so exclusion predicates stay small and bounded. */
export function mergeRanges(
  ranges: readonly TimeRange[],
  limit = 32,
): readonly TimeRange[] {
  const sorted = ranges
    .map((range) => ({
      start: Date.parse(range.startTime),
      end: Date.parse(range.endTime),
    }))
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end > range.start,
    )
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged.slice(0, limit).map((range) => ({
    startTime: new Date(range.start).toISOString(),
    endTime: new Date(range.end).toISOString(),
  }));
}

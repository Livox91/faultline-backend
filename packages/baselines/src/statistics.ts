import type { BaselineStatistics } from './baseline';

/**
 * Explainable statistics only.
 *
 * Every number produced here can be shown to an operator and checked by hand. That is a
 * deliberate constraint for this iteration: a detection nobody can explain is not
 * actionable during an incident.
 */

/**
 * Distance from the mean in standard deviations.
 *
 * Returns undefined when the baseline has no spread to speak of: dividing by a
 * near-zero deviation turns ordinary jitter into an enormous score, which is the classic
 * way a z-score detector becomes a noise generator.
 */
export function zScore(
  value: number,
  mean: number,
  standardDeviation: number,
  minimumDeviation = 0,
): number | undefined {
  const spread = Math.max(standardDeviation, minimumDeviation);
  if (!Number.isFinite(value) || !Number.isFinite(mean) || spread <= 0)
    return undefined;
  return (value - mean) / spread;
}

/**
 * A relative floor on the deviation.
 *
 * A metric that sat at exactly 400 MiB all week has a near-zero deviation, so a move to
 * 500 MiB would otherwise score in the hundreds. Treating "at least 5% of the mean" as
 * the spread keeps such scores finite and comparable across metrics.
 */
export function effectiveDeviation(
  statistics: BaselineStatistics,
  relativeFloor: number,
): number {
  return Math.max(
    statistics.standardDeviation,
    Math.abs(statistics.mean) * relativeFloor,
  );
}

/** Percentage change from a reference value; undefined when the reference is zero. */
export function percentDeviation(
  value: number,
  reference: number,
): number | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference === 0)
    return undefined;
  return ((value - reference) / Math.abs(reference)) * 100;
}

/**
 * How far above a percentile a value sits, as a multiple.
 *
 * Used for skewed distributions such as latency, where "3x the normal p95" is a more
 * honest statement than a z-score over a long tail.
 */
export function percentileRatio(
  value: number,
  percentile: number,
): number | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(percentile) || percentile <= 0)
    return undefined;
  return value / percentile;
}

export interface TrendSample {
  timestamp: number;
  value: number;
}

export interface TrendResult {
  /** Units per millisecond; positive means the metric is climbing. */
  slopePerMs: number;
  /** Goodness of fit, 0-1. Low values mean the samples are noise, not a trend. */
  rSquared: number;
  first: number;
  last: number;
  /** Total change across the observed window as a percentage of the first value. */
  changePercent?: number;
  durationMs: number;
  sampleCount: number;
  /** Fraction of consecutive steps that did not decrease; 1 means strictly monotonic. */
  monotonicFraction: number;
}

/**
 * Ordinary least-squares fit over time.
 *
 * Slope alone is not enough to call something a trend: a sawtooth has a slope too. The
 * caller combines slope with `rSquared` and `monotonicFraction` so a genuinely sustained
 * climb is distinguished from a metric that simply happens to end higher than it began.
 */
export function linearTrend(
  samples: readonly TrendSample[],
): TrendResult | undefined {
  const ordered = [...samples]
    .filter(
      (sample) =>
        Number.isFinite(sample.timestamp) && Number.isFinite(sample.value),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  if (ordered.length < 3) return undefined;
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const durationMs = last.timestamp - first.timestamp;
  if (durationMs <= 0) return undefined;

  const n = ordered.length;
  // Times are offset from the first sample so the regression stays numerically stable.
  const times = ordered.map((sample) => sample.timestamp - first.timestamp);
  const values = ordered.map((sample) => sample.value);
  const meanTime = times.reduce((sum, value) => sum + value, 0) / n;
  const meanValue = values.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let timeVariance = 0;
  let valueVariance = 0;
  for (let index = 0; index < n; index++) {
    const dt = times[index]! - meanTime;
    const dv = values[index]! - meanValue;
    covariance += dt * dv;
    timeVariance += dt * dt;
    valueVariance += dv * dv;
  }
  if (timeVariance <= 0) return undefined;
  const slopePerMs = covariance / timeVariance;
  const rSquared =
    valueVariance <= 0
      ? 0
      : Math.min(1, (covariance * covariance) / (timeVariance * valueVariance));

  let nonDecreasing = 0;
  for (let index = 1; index < n; index++)
    if (values[index]! >= values[index - 1]!) nonDecreasing++;

  return {
    slopePerMs,
    rSquared,
    first: first.value,
    last: last.value,
    ...(first.value !== 0
      ? {
          changePercent: ((last.value - first.value) / Math.abs(first.value)) * 100,
        }
      : {}),
    durationMs,
    sampleCount: n,
    monotonicFraction: nonDecreasing / (n - 1),
  };
}

/** Summary statistics over a set of values; used by the in-memory history adapter. */
export function summarize(
  values: readonly number[],
): BaselineStatistics | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return undefined;
  const sorted = [...finite].sort((a, b) => a - b);
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance =
    finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return {
    sampleCount: finite.length,
    mean,
    min: sorted[0]!,
    max: sorted.at(-1)!,
    standardDeviation: Math.sqrt(variance),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/** Linear interpolation between order statistics, matching ClickHouse `quantile`. */
export function percentile(sorted: readonly number[], level: number): number {
  if (!sorted.length) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const position = level * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/**
 * Per-bucket rate from a monotonic counter.
 *
 * Restart counts and network byte totals reset whenever a container restarts, so a
 * negative delta is read as "the counter restarted from zero" and the bucket's own
 * maximum is used instead. Without this a restart would register as a large negative
 * rate and quietly drag the baseline down.
 */
export function counterDelta(min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const delta = max - min;
  return delta >= 0 ? delta : Math.max(0, max);
}

export function counterRate(
  min: number,
  max: number,
  bucketMs: number,
  perSeconds: number,
): number {
  if (bucketMs <= 0) return 0;
  return (counterDelta(min, max) / bucketMs) * perSeconds * 1000;
}

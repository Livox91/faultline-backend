import type { Anomaly } from '@faultline/incidents';
import type { TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';

export const STATISTICAL_DETECTOR = Symbol('faultline.statistical-detector');

/**
 * Statistical detection, kept deliberately separate from the deterministic rule engine.
 *
 * The two answer different questions and must both be allowed to fire. `memory > 95% of
 * limit` is a rule: it is true or false regardless of history. `memory normally sits at
 * 35% and is now at 70%` is a statistical finding: it says nothing about a threshold and
 * everything about this workload's own past. Merging them would force one to inherit the
 * other's semantics, so they stay apart and meet again at correlation.
 */
export interface StatisticalDetector {
  detect(
    event: TelemetryEvent,
    state?: ResourceState,
  ): Promise<readonly Anomaly[]>;
  commit?(): void | Promise<void>;
  rollback?(): void | Promise<void>;
}

export interface StatisticalDetectionConfig {
  enabled: boolean;
  /** Rolling window of live samples the detector compares against the baseline. */
  evaluationWindowMs: number;
  /** Live samples required before any comparison is attempted. */
  minimumCurrentSamples: number;
  /** Standard deviations above the mean that count as a deviation. */
  zScoreThreshold: number;
  /**
   * Score below which an open anomaly is considered normal again.
   *
   * Strictly lower than the trigger, so a metric hovering on the threshold cannot
   * oscillate between OPEN and RESOLVED on every sample.
   */
  zScoreResolveThreshold: number;
  /** Multiple of the baseline percentile that counts as a latency deviation. */
  percentileRatioThreshold: number;
  percentileRatioResolveThreshold: number;
  /** Consecutive abnormal evaluations before an anomaly opens. */
  minimumConsecutiveWindows: number;
  /** Consecutive normal evaluations before an open anomaly resolves. */
  resolveConsecutiveWindows: number;
  /** Quiet period after a resolve before the same signal may fire again. */
  cooldownMs: number;
  /** Relative floor on the baseline deviation, guarding against near-zero spreads. */
  deviationRelativeFloor: number;
  /** Minimum samples in the growth window before a trend is considered. */
  growthMinimumSamples: number;
  /** Total rise across the growth window, as a percentage, before it counts. */
  growthMinimumPercent: number;
  /** Fit quality a rise must reach to be called sustained rather than noisy. */
  growthMinimumRSquared: number;
  /** Fraction of steps that must not decrease for a rise to count as sustained. */
  growthMinimumMonotonicFraction: number;
}

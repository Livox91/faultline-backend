import { createHash } from 'node:crypto';
import {
  effectiveDeviation,
  linearTrend,
  percentDeviation,
  percentileRatio,
  zScore,
  type BaselineMetricDefinition,
  type BaselineProvider,
  type DetectionSpec,
  type MetricBaseline,
} from '@faultline/baselines';
import type {
  Anomaly,
  AnomalyAffectedResource,
  AnomalyBaselineContext,
  AnomalyEvidence,
  AnomalySeverity,
  StatisticalAnomalyClassification,
} from '@faultline/incidents';
import type { TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';
import { anomalyKey, resourceKey } from '../rules/helpers';
import type {
  StatisticalDetectionConfig,
  StatisticalDetector,
} from './contracts';
import {
  contributionsFor,
  currentObservation,
  definitionFor,
  type CurrentObservation,
  type SignalSample,
} from './signals';

interface SignalState {
  /** Consecutive abnormal evaluations; drives both opening and severity. */
  abnormal: number;
  /** Consecutive normal evaluations; drives resolution. */
  normal: number;
  anomaly?: Anomaly;
  /** Event time before which this signal may not open again after a resolve. */
  cooldownUntil?: number;
}

interface Candidate {
  definition: BaselineMetricDefinition;
  detection: DetectionSpec;
  baseline: MetricBaseline;
  statistics: NonNullable<MetricBaseline['statistics']>;
  observation: CurrentObservation;
  resource: AnomalyAffectedResource;
  score: number;
  /** True while the score sits above the trigger threshold. */
  abnormal: boolean;
  /** True once the score has fallen back below the lower resolve threshold. */
  recovered: boolean;
  evidence: readonly AnomalyEvidence[];
  summary: string;
}

const scoreKinds: Record<DetectionSpec['technique'], string> = {
  'z-score': 'standard-deviations',
  percentile: 'percentile-multiple',
  trend: 'growth-multiple',
};

const severityRank: Record<AnomalySeverity, number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * Compares live telemetry against a workload's own baseline.
 *
 * The detector deliberately owns three things the deterministic engine does not need:
 * rolling windows of live samples (a threshold needs only the latest value, a deviation
 * needs a distribution), baseline lookup, and the noise controls in section "Noise" below.
 *
 * ## Noise
 *
 * Statistical signals flap by nature, so four safeguards apply before anything reaches
 * correlation:
 *
 *  - **minimum samples** - no comparison without enough live samples and a READY baseline
 *  - **duration** - `minimumConsecutiveWindows` abnormal evaluations before opening
 *  - **hysteresis** - resolving needs the score to fall below a strictly lower threshold
 *    for `resolveConsecutiveWindows` evaluations, so a metric sitting on the line cannot
 *    oscillate
 *  - **cooldown** - after resolving, the same signal stays quiet for `cooldownMs`
 *
 * ## Known limitation
 *
 * An open anomaly is only resolved by evidence that the metric came back. If telemetry
 * for a workload stops entirely, its statistical anomalies stay open, and incident
 * stabilization in the correlation engine is what eventually closes the incident.
 */
export class InMemoryStatisticalDetector implements StatisticalDetector {
  private readonly windows = new Map<string, SignalSample[]>();
  private readonly signals = new Map<string, SignalState>();
  private readonly seenIds = new Map<string, number>();

  constructor(
    private readonly baselines: BaselineProvider,
    private readonly config: StatisticalDetectionConfig,
    private readonly capacity = 5_000,
    private readonly samplesPerWindow = 240,
  ) {}

  async detect(
    event: TelemetryEvent,
    state?: ResourceState,
  ): Promise<readonly Anomaly[]> {
    if (!this.config.enabled) return [];
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) return [];
    // Redelivery must not count a sample twice: it would inflate rates and error ratios.
    if (this.seenIds.has(event.id)) return [];
    this.seenIds.set(event.id, time);

    const contributions = contributionsFor(event, state);
    if (!contributions.length) {
      this.prune(time);
      return [];
    }

    const candidatesByKey = new Map<string, Candidate>();
    for (const contribution of contributions) {
      const definition = definitionFor(contribution.metricId);
      if (!definition) continue;
      const { namespace, workload } = contribution.resource;
      // Baselines only exist per workload; unattributed telemetry has nothing to
      // compare against and is skipped rather than compared to something unrelated.
      if (!namespace || !workload) continue;

      const samples = this.record(contribution.resource, definition.id, {
        timestamp: contribution.sample.timestamp,
        value: contribution.sample.value,
      });
      const snapshot = await this.baselines.forWorkload({
        clusterId: contribution.resource.clusterId,
        namespace,
        workload,
      });
      const baseline = snapshot.get(definition.id);
      // BASELINE_NOT_READY is a first-class answer: a newly deployed workload has no
      // history, and calling its ordinary behaviour anomalous would be worse than silence.
      if (!baseline?.statistics || baseline.status !== 'READY') continue;
      const observation = currentObservation(samples, definition);
      if (
        !observation ||
        observation.sampleCount < this.config.minimumCurrentSamples
      )
        continue;

      for (const detection of definition.detections) {
        const candidate = this.score(
          definition,
          detection,
          baseline,
          observation,
          samples,
          contribution.resource,
        );
        if (!candidate) continue;
        const key = anomalyKey(detection.classification, candidate.resource);
        const existing = candidatesByKey.get(key);
        // Memory usage and memory utilization both speak to MEMORY_USAGE_ANOMALY; the
        // stronger signal is the one reported, so one deviation never opens two anomalies.
        if (!existing || candidate.score > existing.score)
          candidatesByKey.set(key, candidate);
      }
    }

    const emitted: Anomaly[] = [];
    for (const [key, candidate] of candidatesByKey)
      emitted.push(...this.advance(key, candidate, event, time));
    this.prune(time);
    return emitted;
  }

  /** Serializable operational state; mirrors the deterministic engine's Redis contract. */
  exportState(): unknown {
    return {
      version: 1,
      windows: [...this.windows],
      signals: [...this.signals],
      seenIds: [...this.seenIds],
    };
  }

  importState(value: unknown): void {
    if (
      !value ||
      typeof value !== 'object' ||
      (value as { version?: unknown }).version !== 1
    )
      return;
    const state = value as {
      windows?: [string, SignalSample[]][];
      signals?: [string, SignalState][];
      seenIds?: [string, number][];
    };
    this.windows.clear();
    this.signals.clear();
    this.seenIds.clear();
    for (const item of state.windows ?? []) this.windows.set(...item);
    for (const item of state.signals ?? []) this.signals.set(...item);
    for (const item of state.seenIds ?? []) this.seenIds.set(...item);
  }

  private record(
    resource: AnomalyAffectedResource,
    metricId: string,
    sample: SignalSample,
  ): readonly SignalSample[] {
    const key = `${resourceKey(resource)}|${metricId}`;
    const samples = this.windows.get(key) ?? [];
    samples.push(sample);
    const cutoff = sample.timestamp - this.config.evaluationWindowMs;
    const retained = samples
      .filter((item) => item.timestamp >= cutoff)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-this.samplesPerWindow);
    this.windows.set(key, retained);
    return retained;
  }

  private score(
    definition: BaselineMetricDefinition,
    detection: DetectionSpec,
    baseline: MetricBaseline,
    observation: CurrentObservation,
    samples: readonly SignalSample[],
    resource: AnomalyAffectedResource,
  ): Candidate | undefined {
    const statistics = baseline.statistics!;
    const common = {
      definition,
      detection,
      baseline,
      statistics,
      observation,
      resource,
    };

    if (detection.technique === 'trend')
      return this.scoreTrend(common, samples);

    // A workload idling near zero can double without meaning anything; the floor keeps
    // those arithmetic curiosities out of the incident stream.
    if (
      definition.minimumMeaningfulValue !== undefined &&
      observation.value < definition.minimumMeaningfulValue
    )
      return undefined;

    if (detection.technique === 'percentile') {
      const reference =
        detection.percentile === 'p99' ? statistics.p99 : statistics.p95;
      const ratio = percentileRatio(observation.p95 ?? observation.value, reference);
      if (ratio === undefined) return undefined;
      const current = observation.p95 ?? observation.value;
      const deviation = percentDeviation(current, reference);
      return {
        ...common,
        score: round(ratio, 2),
        abnormal: ratio >= this.config.percentileRatioThreshold,
        recovered: ratio < this.config.percentileRatioResolveThreshold,
        summary: `${definition.label} ${detection.percentile ?? 'p95'} is ${format(current, definition.unit)} against a normal ${format(reference, definition.unit)}`,
        evidence: [
          calculation(
            baseline,
            `Current ${definition.label} ${detection.percentile ?? 'p95'} over ${Math.round(observation.windowMs / 1000)}s`,
            {
              current: round(current, 3),
              samples: observation.sampleCount,
              ...(deviation !== undefined
                ? { deviationPercent: round(deviation, 1) }
                : {}),
            },
          ),
          baselineEvidence(baseline, statistics, definition, ratio, detection),
        ],
      };
    }

    const spread = effectiveDeviation(
      statistics,
      this.config.deviationRelativeFloor,
    );
    const raw = zScore(observation.value, statistics.mean, spread);
    if (raw === undefined) return undefined;
    const magnitude = detection.direction === 'both' ? Math.abs(raw) : raw;
    const deviation = percentDeviation(observation.value, statistics.mean);
    return {
      ...common,
      score: round(magnitude, 2),
      abnormal: magnitude >= this.config.zScoreThreshold,
      recovered: magnitude < this.config.zScoreResolveThreshold,
      summary: `${definition.label} is ${format(observation.value, definition.unit)} against a normal ${format(statistics.mean, definition.unit)}`,
      evidence: [
        calculation(
          baseline,
          `Current ${definition.label} averaged over ${Math.round(observation.windowMs / 1000)}s`,
          {
            current: round(observation.value, 3),
            samples: observation.sampleCount,
            ...(deviation !== undefined
              ? { deviationPercent: round(deviation, 1) }
              : {}),
          },
        ),
        baselineEvidence(baseline, statistics, definition, magnitude, detection),
      ],
    };
  }

  /**
   * Sustained growth, not "it went up".
   *
   * A rise only counts when the fit is good, the climb is mostly monotonic and the total
   * change clears a configured percentage. That is why the classification says
   * MEMORY_GROWTH_ANOMALY and not "memory leak": Faultline can see the shape of the
   * curve, but not the reason for it.
   */
  private scoreTrend(
    common: Omit<
      Candidate,
      'score' | 'abnormal' | 'recovered' | 'evidence' | 'summary'
    >,
    samples: readonly SignalSample[],
  ): Candidate | undefined {
    const { definition, baseline, statistics } = common;
    if (samples.length < this.config.growthMinimumSamples) return undefined;
    const trend = linearTrend(samples);
    if (!trend || trend.changePercent === undefined) return undefined;
    const growth = trend.changePercent;
    const sustained =
      trend.rSquared >= this.config.growthMinimumRSquared &&
      trend.monotonicFraction >= this.config.growthMinimumMonotonicFraction &&
      trend.slopePerMs > 0;
    const score = round(growth / this.config.growthMinimumPercent, 2);
    const perHour = trend.slopePerMs * 3_600_000;
    return {
      ...common,
      score,
      abnormal: sustained && growth >= this.config.growthMinimumPercent,
      // Recovery means the climb stopped, not that memory returned to its old value.
      recovered: !sustained || growth < this.config.growthMinimumPercent / 2,
      summary: `${definition.label} rose ${round(growth, 1)}% over ${Math.round(trend.durationMs / 60_000)} minutes without levelling off`,
      evidence: [
        calculation(baseline, `Sustained ${definition.label} growth`, {
          from: round(trend.first, 3),
          to: round(trend.last, 3),
          changePercent: round(growth, 1),
          perHour: round(perHour, 3),
          rSquared: round(trend.rSquared, 3),
          monotonicFraction: round(trend.monotonicFraction, 2),
          samples: trend.sampleCount,
          windowMinutes: round(trend.durationMs / 60_000, 1),
        }),
        baselineEvidence(baseline, statistics, definition, score, {
          classification: 'MEMORY_GROWTH_ANOMALY',
          technique: 'trend',
          direction: 'above',
        }),
      ],
    };
  }

  /** Applies the noise controls and produces anomaly lifecycle transitions. */
  private advance(
    key: string,
    candidate: Candidate,
    event: TelemetryEvent,
    time: number,
  ): readonly Anomaly[] {
    const state = this.signals.get(key) ?? { abnormal: 0, normal: 0 };

    if (candidate.abnormal) {
      state.abnormal++;
      state.normal = 0;
    } else if (candidate.recovered) {
      state.normal++;
      state.abnormal = 0;
    } else {
      // Inside the hysteresis band neither counter advances: the signal is neither
      // clearly abnormal nor clearly recovered, so its current verdict simply holds.
      this.signals.set(key, state);
      return [];
    }

    if (state.anomaly && candidate.abnormal) {
      const updated = this.build(candidate, event, state, {
        base: state.anomaly,
        status: 'ACTIVE',
      });
      state.anomaly = updated;
      this.signals.set(key, state);
      return [updated];
    }

    if (
      state.anomaly &&
      state.normal >= this.config.resolveConsecutiveWindows
    ) {
      const resolved: Anomaly = {
        ...state.anomaly,
        status: 'RESOLVED',
        timestamp: event.timestamp,
        lastSeen: event.timestamp,
        evidence: [
          ...state.anomaly.evidence,
          calculation(
            candidate.baseline,
            `${candidate.definition.label} returned within its normal range`,
            { current: round(candidate.observation.value, 3), score: candidate.score },
          ),
        ].slice(-12),
      };
      this.signals.set(key, {
        abnormal: 0,
        normal: 0,
        cooldownUntil: time + this.config.cooldownMs,
      });
      return [resolved];
    }

    if (
      !state.anomaly &&
      candidate.abnormal &&
      state.abnormal >= this.config.minimumConsecutiveWindows &&
      !(state.cooldownUntil !== undefined && time < state.cooldownUntil)
    ) {
      const opened = this.build(candidate, event, state, { status: 'OPEN' });
      state.anomaly = opened;
      this.signals.set(key, state);
      return [opened];
    }

    this.signals.set(key, state);
    return [];
  }

  private build(
    candidate: Candidate,
    event: TelemetryEvent,
    state: SignalState,
    options: { base?: Anomaly; status: 'OPEN' | 'ACTIVE' },
  ): Anomaly {
    const classification = candidate.detection
      .classification as StatisticalAnomalyClassification;
    const dedupeKey = anomalyKey(classification, candidate.resource);
    const confidence = this.confidence(candidate, state);
    const severity = this.severity(candidate, state, confidence, dedupeKey);
    const evidence = options.base
      ? mergeEvidence(options.base.evidence, candidate.evidence)
      : candidate.evidence;
    return {
      anomalyId:
        options.base?.anomalyId ??
        createHash('sha256')
          .update(`${dedupeKey}:${event.timestamp}`)
          .digest('hex'),
      dedupeKey,
      ruleId: `statistical.${candidate.definition.id}.${candidate.detection.technique}.v1`,
      classification,
      source: 'STATISTICAL',
      severity,
      anomalyScore: candidate.score,
      confidence,
      baseline: baselineContext(candidate.baseline, candidate.statistics),
      clusterId: candidate.resource.clusterId,
      affectedResource: candidate.resource,
      timestamp: event.timestamp,
      summary: candidate.summary,
      evidence,
      status: options.status,
      firstSeen: options.base?.firstSeen ?? event.timestamp,
      lastSeen: event.timestamp,
    };
  }

  /**
   * How much this finding can be trusted, as opposed to how far from normal it is.
   *
   * Driven by evidence quality: how deep the baseline is, how long the deviation has
   * persisted, and how many live samples backed the comparison. A large score on a thin
   * baseline stays a low-confidence finding, which is exactly the distinction the score
   * and confidence split exists to preserve.
   */
  private confidence(candidate: Candidate, state: SignalState): number {
    const depth = Math.min(
      1,
      candidate.statistics.sampleCount / (this.config.minimumCurrentSamples * 20),
    );
    const persistence = Math.min(
      1,
      state.abnormal / Math.max(1, this.config.minimumConsecutiveWindows * 2),
    );
    const evidence = Math.min(
      1,
      candidate.observation.sampleCount /
        Math.max(1, this.config.minimumCurrentSamples * 3),
    );
    return round(
      Math.min(
        0.95,
        0.5 + 0.25 * depth + 0.15 * persistence + 0.1 * evidence,
      ),
      2,
    );
  }

  /**
   * Severity from magnitude, duration, blast radius, baseline trust and corroboration.
   *
   * A brief single-replica wobble is capped at WARNING no matter how large the score:
   * one container spiking for a minute is not the same operational event as three
   * replicas degrading for a quarter of an hour, and paging as if it were is how
   * statistical detection loses an operator's trust.
   */
  private severity(
    candidate: Candidate,
    state: SignalState,
    confidence: number,
    dedupeKey: string,
  ): AnomalySeverity {
    const threshold =
      candidate.detection.technique === 'percentile'
        ? this.config.percentileRatioThreshold
        : candidate.detection.technique === 'trend'
          ? 1
          : this.config.zScoreThreshold;
    const magnitude = candidate.score / Math.max(threshold, 0.0001);
    const duration =
      state.abnormal / Math.max(1, this.config.minimumConsecutiveWindows);
    const replicas = this.affectedReplicas(candidate, dedupeKey);
    const supporting = this.supportingAnomalies(candidate, dedupeKey);

    let points = 0;
    points += magnitude >= 3 ? 3 : magnitude >= 2 ? 2 : magnitude >= 1.5 ? 1 : 0;
    points += duration >= 4 ? 2 : duration >= 2 ? 1 : 0;
    points += replicas >= 3 ? 2 : replicas >= 2 ? 1 : 0;
    points += supporting >= 2 ? 2 : supporting >= 1 ? 1 : 0;
    points += confidence >= 0.85 ? 1 : confidence < 0.6 ? -1 : 0;

    const severity: AnomalySeverity =
      points >= 7
        ? 'CRITICAL'
        : points >= 4
          ? 'HIGH'
          : points >= 2
            ? 'WARNING'
            : 'INFO';
    if (replicas <= 1 && duration < 2)
      return severityRank[severity] > severityRank.WARNING
        ? 'WARNING'
        : severity;
    return severity;
  }

  /** Distinct pods currently showing this same classification for this workload. */
  private affectedReplicas(candidate: Candidate, dedupeKey: string): number {
    const pods = new Set<string>();
    const own = candidate.resource.podUid ?? candidate.resource.pod;
    if (own) pods.add(own);
    for (const [key, state] of this.signals) {
      if (key === dedupeKey || !state.anomaly) continue;
      if (state.anomaly.classification !== candidate.detection.classification)
        continue;
      if (!sameWorkloadResource(state.anomaly.affectedResource, candidate.resource))
        continue;
      const pod =
        state.anomaly.affectedResource.podUid ??
        state.anomaly.affectedResource.pod;
      if (pod) pods.add(pod);
    }
    return pods.size;
  }

  /** Other open statistical anomalies on the same workload, whatever their metric. */
  private supportingAnomalies(
    candidate: Candidate,
    dedupeKey: string,
  ): number {
    let supporting = 0;
    for (const [key, state] of this.signals) {
      if (key === dedupeKey || !state.anomaly) continue;
      if (state.anomaly.classification === candidate.detection.classification)
        continue;
      if (sameWorkloadResource(state.anomaly.affectedResource, candidate.resource))
        supporting++;
    }
    return supporting;
  }

  private prune(time: number): void {
    const cutoff = time - this.config.evaluationWindowMs;
    for (const [id, timestamp] of this.seenIds) {
      if (this.seenIds.size <= this.capacity && timestamp >= cutoff) break;
      this.seenIds.delete(id);
    }
    while (this.windows.size > this.capacity)
      this.windows.delete(this.windows.keys().next().value!);
    while (this.signals.size > this.capacity)
      this.signals.delete(this.signals.keys().next().value!);
  }
}

function sameWorkloadResource(
  a: AnomalyAffectedResource,
  b: AnomalyAffectedResource,
): boolean {
  return (
    a.clusterId === b.clusterId &&
    a.namespace === b.namespace &&
    Boolean(a.workload) &&
    a.workload === b.workload
  );
}

function baselineContext(
  baseline: MetricBaseline,
  statistics: NonNullable<MetricBaseline['statistics']>,
): AnomalyBaselineContext {
  return {
    metricName: baseline.metricName,
    window: baseline.window,
    sampleCount: statistics.sampleCount,
    mean: round(statistics.mean, 3),
    p50: round(statistics.p50, 3),
    p95: round(statistics.p95, 3),
    standardDeviation: round(statistics.standardDeviation, 3),
    ...(baseline.unit ? { unit: baseline.unit } : {}),
    updatedAt: baseline.updatedAt,
    excludedRanges: baseline.excludedRanges,
  };
}

function baselineEvidence(
  baseline: MetricBaseline,
  statistics: NonNullable<MetricBaseline['statistics']>,
  definition: BaselineMetricDefinition,
  score: number,
  detection: DetectionSpec,
): AnomalyEvidence {
  return {
    type: 'baseline',
    summary: `Expected ${definition.label} from ${baseline.window} of history`,
    timestamp: baseline.updatedAt,
    attributes: {
      metric: baseline.metricName,
      window: baseline.window,
      sampleCount: statistics.sampleCount,
      mean: round(statistics.mean, 3),
      p50: round(statistics.p50, 3),
      p95: round(statistics.p95, 3),
      p99: round(statistics.p99, 3),
      standardDeviation: round(statistics.standardDeviation, 3),
      anomalyScore: round(score, 2),
      // Names the unit of `anomalyScore` so 3.8 is never read as the wrong quantity.
      scoreKind: scoreKinds[detection.technique],
      excludedRanges: baseline.excludedRanges,
      ...(baseline.unit ? { unit: baseline.unit } : {}),
    },
  };
}

function calculation(
  baseline: MetricBaseline,
  summary: string,
  attributes: Record<string, number | string>,
): AnomalyEvidence {
  return {
    type: 'calculation',
    summary,
    timestamp: new Date().toISOString(),
    attributes: { metric: baseline.metricName, ...attributes },
  };
}

function mergeEvidence(
  existing: readonly AnomalyEvidence[],
  next: readonly AnomalyEvidence[],
): readonly AnomalyEvidence[] {
  // Statistical evidence is regenerated on every evaluation, so the newest numbers
  // replace the previous ones for the same summary rather than accumulating.
  const merged = existing.filter(
    (item) => !next.some((candidate) => candidate.summary === item.summary),
  );
  return [...merged, ...next].slice(-12);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : 0;
}

function format(value: number, unit?: string): string {
  if (unit === 'By') return `${round(value / (1024 * 1024), 1)} MiB`;
  if (unit === '%') return `${round(value, 1)}%`;
  if (unit === 'ms') return `${round(value, 0)} ms`;
  return unit ? `${round(value, 3)} ${unit}` : String(round(value, 3));
}

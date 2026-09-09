import {
  ALL_SEASONS,
  baselineWindowMs,
  type BaselineRepository,
  type MetricBaseline,
} from './baseline';
import {
  baselineMetricDefinitions,
  windowFor,
  type BaselineMetricDefinition,
  type BaselineWindowSettings,
} from './catalog';
import {
  mergeRanges,
  type BaselineTarget,
  type HistoricalTelemetryQuery,
  type TimeRange,
} from './history';

export interface BaselineEngineConfig {
  windows: BaselineWindowSettings;
  /** Below this, a baseline reports BASELINE_NOT_READY rather than a shaky mean. */
  minimumSamples: number;
  /** Bucket width for derived signals (rates, ratios, error rates). */
  bucketMs: number;
  /** Ceiling on workloads refreshed per run, so one cluster cannot monopolise a cycle. */
  maxTargets: number;
  /** Row ceiling handed to the history port for one summary. */
  maxSamplesPerSummary: number;
  /** Whether to remove known-bad periods before computing. */
  excludeDisruptedPeriods: boolean;
  /** Padding either side of a disruption marker. */
  disruptionPaddingMs: number;
  /** Kubernetes event reasons treated as disruption markers. */
  disruptionReasons: readonly string[];
}

export const defaultDisruptionReasons: readonly string[] = [
  'OOMKilling',
  'OOMKilled',
  'BackOff',
  'CrashLoopBackOff',
  'Evicted',
  'FailedScheduling',
  'Unhealthy',
  'NodeNotReady',
];

export interface BaselineRefreshResult {
  targets: number;
  computed: number;
  ready: number;
  notReady: number;
  excludedRanges: number;
  durationMs: number;
}

/** Time ranges supplied by the caller, e.g. incident windows from PostgreSQL. */
export type ExclusionSource = (
  target: BaselineTarget,
  window: TimeRange,
) => Promise<readonly TimeRange[]>;

/**
 * Turns telemetry history into expected behaviour.
 *
 * Runs on a schedule rather than per event: recomputing a 24-hour distribution for every
 * arriving sample would cost far more than it could ever be worth, and baselines by
 * definition change slowly.
 *
 * ## Baseline pollution
 *
 * A baseline computed straight from history would happily learn that a two-hour outage
 * is normal, and then stay quiet the next time it happens. Before summarizing, the
 * engine subtracts periods where the workload was demonstrably unhealthy:
 *
 *  - windows of active HIGH/CRITICAL incidents, supplied by the caller
 *  - windows around Kubernetes warning events such as OOMKilling, BackOff and Evicted
 *
 * ### Known limitations
 *
 * This is coarse on purpose. Degradation that never produced an incident or a Kubernetes
 * warning - a slow leak, a quiet latency regression - is still learned as normal, and an
 * excluded stretch shrinks the sample count, so a workload that spent most of the window
 * unhealthy may fall back to BASELINE_NOT_READY instead of producing a cleaner baseline.
 * Both are safer failure modes than the alternative, and both are visible: the baselines
 * API reports `excludedRanges` and `sampleCount` for every row.
 */
export class BaselineEngine {
  constructor(
    private readonly history: HistoricalTelemetryQuery,
    private readonly repository: BaselineRepository,
    private readonly config: BaselineEngineConfig,
    /** Extra exclusions, e.g. active incident windows read from PostgreSQL. */
    private readonly exclusions?: ExclusionSource,
    private readonly definitions: readonly BaselineMetricDefinition[] = baselineMetricDefinitions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Recomputes every baseline for the workloads that reported telemetry recently. */
  async refresh(clusterIds?: readonly string[]): Promise<BaselineRefreshResult> {
    const started = this.now();
    const discoveryWindow = this.windowEnding(started, baselineWindowMs['1h']);
    const targets = await this.history.listBaselineTargets({
      ...(clusterIds?.length ? { clusterIds } : {}),
      metricNames: this.discoveryMetricNames(),
      window: discoveryWindow,
      limit: this.config.maxTargets,
    });
    let computed = 0;
    let ready = 0;
    let excludedRanges = 0;
    const baselines: MetricBaseline[] = [];
    for (const target of targets) {
      for (const definition of this.definitions) {
        const window = this.windowEnding(
          started,
          baselineWindowMs[windowFor(definition, this.config.windows)],
        );
        const exclude = await this.exclusionsFor(target, window);
        excludedRanges += exclude.length;
        const baseline = await this.computeOne(
          target,
          definition,
          window,
          exclude,
        );
        computed++;
        if (baseline.status === 'READY') ready++;
        baselines.push(baseline);
      }
    }
    if (baselines.length) await this.repository.save(baselines);
    return {
      targets: targets.length,
      computed,
      ready,
      notReady: computed - ready,
      excludedRanges,
      durationMs: this.now() - started,
    };
  }

  /** Computes one baseline without persisting it; used by tests and by `refresh`. */
  async computeOne(
    target: BaselineTarget,
    definition: BaselineMetricDefinition,
    window: TimeRange,
    exclude: readonly TimeRange[] = [],
  ): Promise<MetricBaseline> {
    const summary = await this.history.summarizeMetric({
      clusterId: target.clusterId,
      namespace: target.namespace,
      workload: target.workload,
      source: definition.source,
      window,
      bucketMs: this.config.bucketMs,
      exclude,
      maxSamples: this.config.maxSamplesPerSummary,
    });
    // Insufficient history is reported, never guessed at. A freshly deployed workload
    // must not have its first ten minutes treated as a law of nature.
    const ready =
      summary.statistics !== undefined &&
      summary.sampleCount >= this.config.minimumSamples;
    return {
      clusterId: target.clusterId,
      namespace: target.namespace,
      workload: target.workload,
      resourceType: definition.resourceType,
      metricName: definition.id,
      window: windowFor(definition, this.config.windows),
      season: ALL_SEASONS,
      status: ready ? 'READY' : 'BASELINE_NOT_READY',
      ...(ready ? { statistics: summary.statistics } : {}),
      sampleCount: summary.sampleCount,
      ...(summary.unit ?? definition.unit
        ? { unit: summary.unit ?? definition.unit }
        : {}),
      windowStart: window.startTime,
      windowEnd: window.endTime,
      excludedRanges: exclude.length,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async exclusionsFor(
    target: BaselineTarget,
    window: TimeRange,
  ): Promise<readonly TimeRange[]> {
    if (!this.config.excludeDisruptedPeriods) return [];
    const [supplied, disruptions] = await Promise.all([
      this.exclusions?.(target, window) ?? Promise.resolve([]),
      this.history.findDisruptionWindows({
        clusterId: target.clusterId,
        namespace: target.namespace,
        workload: target.workload,
        window,
        reasons: this.config.disruptionReasons,
        paddingMs: this.config.disruptionPaddingMs,
        limit: 200,
      }),
    ]);
    return mergeRanges([...supplied, ...disruptions]);
  }

  /** Metrics whose presence proves a workload is alive and reporting. */
  private discoveryMetricNames(): readonly string[] {
    const names = new Set<string>();
    for (const definition of this.definitions)
      if (definition.source.kind === 'gauge')
        names.add(definition.source.metricName);
      else if (definition.source.kind === 'counter-rate')
        names.add(definition.source.metricName);
      else if (definition.source.kind === 'ratio')
        names.add(definition.source.numerator.metricName);
    return [...names];
  }

  private windowEnding(endMs: number, durationMs: number): TimeRange {
    return {
      startTime: new Date(endMs - durationMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    };
  }
}

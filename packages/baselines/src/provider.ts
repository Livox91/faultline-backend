import type {
  BaselineRepository,
  BaselineWorkloadRef,
  MetricBaseline,
} from './baseline';

export const BASELINE_PROVIDER = Symbol('faultline.baseline-provider');

/**
 * Read-through baseline lookup for the detector.
 *
 * The detector consults baselines on every telemetry event, so a repository round trip
 * per event is out of the question. Baselines change only when the refresh job runs, so
 * a short TTL cache is both safe and sufficient.
 */
export interface BaselineProvider {
  /** Every baseline known for one workload, keyed by metric name. */
  forWorkload(
    workload: BaselineWorkloadRef,
  ): Promise<ReadonlyMap<string, MetricBaseline>>;
  invalidate(): void;
}

interface CacheEntry {
  expiresAt: number;
  baselines: ReadonlyMap<string, MetricBaseline>;
}

export class CachedBaselineProvider implements BaselineProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<ReadonlyMap<string, MetricBaseline>>
  >();

  constructor(
    private readonly repository: BaselineRepository,
    private readonly ttlMs = 60_000,
    private readonly capacity = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async forWorkload(
    workload: BaselineWorkloadRef,
  ): Promise<ReadonlyMap<string, MetricBaseline>> {
    const key = workloadKey(workload);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.baselines;
    // Collapse concurrent misses for the same workload into one repository read.
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const load = this.load(workload, key).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, load);
    return load;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async load(
    workload: BaselineWorkloadRef,
    key: string,
  ): Promise<ReadonlyMap<string, MetricBaseline>> {
    let baselines: readonly MetricBaseline[] = [];
    try {
      baselines = await this.repository.listForWorkload(workload);
    } catch {
      // A baseline store outage must not stop deterministic detection, so an empty
      // snapshot is cached briefly: statistical checks pause, everything else runs on.
      const empty = new Map<string, MetricBaseline>();
      this.remember(key, empty, this.now() + Math.min(this.ttlMs, 10_000));
      return empty;
    }
    const map = new Map<string, MetricBaseline>();
    for (const baseline of baselines) map.set(baseline.metricName, baseline);
    this.remember(key, map, this.now() + this.ttlMs);
    return map;
  }

  private remember(
    key: string,
    baselines: ReadonlyMap<string, MetricBaseline>,
    expiresAt: number,
  ): void {
    this.cache.delete(key);
    this.cache.set(key, { expiresAt, baselines });
    while (this.cache.size > this.capacity)
      this.cache.delete(this.cache.keys().next().value!);
  }
}

function workloadKey(workload: BaselineWorkloadRef): string {
  return [workload.clusterId, workload.namespace, workload.workload].join('|');
}

/**
 * Baseline domain.
 *
 * A baseline is what a specific workload's specific metric normally looks like. It is
 * deliberately independent of where the history came from: the engine reads through the
 * `HistoricalTelemetryQuery` port and writes through `BaselineRepository`, so no
 * detection code depends on ClickHouse.
 */

export const BASELINE_REPOSITORY = Symbol('faultline.baseline-repository');

/** Historical windows a baseline may be computed over. */
export const baselineWindows = ['1h', '6h', '24h', '7d'] as const;
export type BaselineWindow = (typeof baselineWindows)[number];

export const baselineWindowMs: Record<BaselineWindow, number> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

export function isBaselineWindow(value: unknown): value is BaselineWindow {
  return (
    typeof value === 'string' &&
    (baselineWindows as readonly string[]).includes(value)
  );
}

/**
 * What the samples describe.
 *
 * Baselines are computed per workload (see `BaselineScope`), but the samples behind them
 * may come from container-, pod- or node-level telemetry, and a future consumer needs to
 * know which.
 */
export const baselineResourceTypes = [
  'workload',
  'pod',
  'container',
  'node',
] as const;
export type BaselineResourceType = (typeof baselineResourceTypes)[number];

/**
 * Which slice of time a baseline covers.
 *
 * Only `all` is produced today, but every key, row and API response carries the season,
 * so adding "Monday 09:00 behaves differently from Sunday 03:00" later is a new season
 * kind rather than a redesign: nothing here assumes one average describes all hours.
 */
export type SeasonKey =
  | { kind: 'all' }
  /** Reserved: 0-167, hour of week in UTC. Not produced by this iteration. */
  | { kind: 'hour-of-week'; bucket: number };

export const ALL_SEASONS: SeasonKey = { kind: 'all' };

export function encodeSeason(season: SeasonKey): string {
  return season.kind === 'all' ? 'all' : `hour-of-week:${season.bucket}`;
}

export function decodeSeason(value: string): SeasonKey | undefined {
  if (value === 'all') return ALL_SEASONS;
  const match = /^hour-of-week:(\d{1,3})$/.exec(value);
  if (!match) return undefined;
  const bucket = Number(match[1]);
  return bucket >= 0 && bucket <= 167 ? { kind: 'hour-of-week', bucket } : undefined;
}

/**
 * Baselines are scoped to one workload's own history.
 *
 * Comparing `payment-api` against `search-api` would be meaningless, so the scope always
 * carries cluster, namespace and workload rather than aggregating globally.
 */
export interface BaselineWorkloadRef {
  clusterId: string;
  namespace: string;
  workload: string;
}

export interface BaselineScope extends BaselineWorkloadRef {
  resourceType: BaselineResourceType;
}

export interface BaselineKey extends BaselineScope {
  metricName: string;
  window: BaselineWindow;
  season: SeasonKey;
}

export type BaselineStatus = 'READY' | 'BASELINE_NOT_READY';

/** Distribution summary. Percentiles matter more than the mean for skewed signals. */
export interface BaselineStatistics {
  sampleCount: number;
  mean: number;
  min: number;
  max: number;
  standardDeviation: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricBaseline extends BaselineKey {
  status: BaselineStatus;
  /** Present only when `status` is READY; an unready baseline still records its count. */
  statistics?: BaselineStatistics;
  sampleCount: number;
  unit?: string;
  windowStart: string;
  windowEnd: string;
  /** Time ranges removed as likely-polluted before computing (see `BaselineEngine`). */
  excludedRanges: number;
  updatedAt: string;
}

export function baselineKeyString(key: BaselineKey): string {
  return [
    key.clusterId,
    key.namespace,
    key.workload,
    key.resourceType,
    key.metricName,
    key.window,
    encodeSeason(key.season),
  ].join('|');
}

export interface BaselineFilter {
  clusterIds?: readonly string[];
  clusterId?: string;
  namespace?: string;
  workload?: string;
  metricName?: string;
  window?: BaselineWindow;
  status?: BaselineStatus;
  limit?: number;
}

export interface BaselineRepository {
  /** Upserts a batch; refresh writes every recomputed baseline in one call. */
  save(baselines: readonly MetricBaseline[]): Promise<void>;
  get(key: BaselineKey): Promise<MetricBaseline | undefined>;
  /** All baselines for one workload, used by the detector's per-event lookup. */
  listForWorkload(
    workload: BaselineWorkloadRef,
  ): Promise<readonly MetricBaseline[]>;
  list(filter?: BaselineFilter): Promise<readonly MetricBaseline[]>;
  /** Removes baselines not refreshed since `before`, so deleted workloads age out. */
  deleteStale(before: string): Promise<number>;
}

/** Bounded process-local repository for tests and the development pipeline. */
export class InMemoryBaselineRepository implements BaselineRepository {
  private readonly baselines = new Map<string, MetricBaseline>();

  constructor(private readonly capacity = 20_000) {}

  async save(baselines: readonly MetricBaseline[]): Promise<void> {
    for (const baseline of baselines) {
      this.baselines.delete(baselineKeyString(baseline));
      this.baselines.set(baselineKeyString(baseline), structuredClone(baseline));
    }
    while (this.baselines.size > this.capacity)
      this.baselines.delete(this.baselines.keys().next().value!);
  }

  async get(key: BaselineKey): Promise<MetricBaseline | undefined> {
    const baseline = this.baselines.get(baselineKeyString(key));
    return baseline ? structuredClone(baseline) : undefined;
  }

  async listForWorkload(
    workload: BaselineWorkloadRef,
  ): Promise<readonly MetricBaseline[]> {
    return [...this.baselines.values()]
      .filter(
        (baseline) =>
          baseline.clusterId === workload.clusterId &&
          baseline.namespace === workload.namespace &&
          baseline.workload === workload.workload,
      )
      .map((baseline) => structuredClone(baseline));
  }

  async list(filter: BaselineFilter = {}): Promise<readonly MetricBaseline[]> {
    return [...this.baselines.values()]
      .filter(
        (baseline) =>
          (!filter.clusterIds || filter.clusterIds.includes(baseline.clusterId)) &&
          (!filter.clusterId || baseline.clusterId === filter.clusterId) &&
          (!filter.namespace || baseline.namespace === filter.namespace) &&
          (!filter.workload || baseline.workload === filter.workload) &&
          (!filter.metricName || baseline.metricName === filter.metricName) &&
          (!filter.window || baseline.window === filter.window) &&
          (!filter.status || baseline.status === filter.status),
      )
      .sort(
        (a, b) =>
          a.clusterId.localeCompare(b.clusterId) ||
          a.namespace.localeCompare(b.namespace) ||
          a.workload.localeCompare(b.workload) ||
          a.metricName.localeCompare(b.metricName),
      )
      .slice(0, filter.limit ?? 200)
      .map((baseline) => structuredClone(baseline));
  }

  async deleteStale(before: string): Promise<number> {
    const cutoff = Date.parse(before);
    let removed = 0;
    for (const [key, baseline] of this.baselines)
      if (Date.parse(baseline.updatedAt) < cutoff) {
        this.baselines.delete(key);
        removed++;
      }
    return removed;
  }
}

let developmentRepository: BaselineRepository | undefined;
export function getDevelopmentBaselineRepository(): BaselineRepository {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development baseline repository is disabled in production');
  return (developmentRepository ??= new InMemoryBaselineRepository());
}

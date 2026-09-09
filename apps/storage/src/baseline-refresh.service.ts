import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  BASELINE_REPOSITORY,
  BaselineEngine,
  HISTORICAL_TELEMETRY_QUERY,
  defaultDisruptionReasons,
  type BaselineRefreshResult,
  type BaselineRepository,
  type BaselineTarget,
  type HistoricalTelemetryQuery,
  type TimeRange,
} from '@faultline/baselines';
import {
  INCIDENT_REPOSITORY,
  type Incident,
  type IncidentRepository,
} from '@faultline/incidents';

/**
 * Scheduled baseline refresh.
 *
 * Runs here rather than in the processor for two reasons. This service already owns the
 * ClickHouse connection that holds telemetry history, and keeping the derivation on this
 * side is what allows the processor to have no ClickHouse dependency at all: it reads
 * finished baselines from PostgreSQL and keeps detecting even when history is down.
 *
 * Refresh is scheduled rather than incremental. Recomputing a 24-hour distribution per
 * arriving sample would cost enormously more than it could be worth, and a baseline that
 * moves within one interval was never a baseline.
 */
@Injectable()
export class BaselineRefreshService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private readonly engine: BaselineEngine;

  constructor(
    @Inject(HISTORICAL_TELEMETRY_QUERY)
    history: HistoricalTelemetryQuery,
    @Inject(BASELINE_REPOSITORY)
    private readonly repository: BaselineRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly logger: ApplicationLogger,
    @Optional()
    @Inject(INCIDENT_REPOSITORY)
    private readonly incidents?: IncidentRepository,
  ) {
    const settings = config.baselines;
    this.engine = new BaselineEngine(
      history,
      repository,
      {
        windows: settings.windows,
        minimumSamples: settings.minimumSamples,
        bucketMs: settings.bucketMs,
        maxTargets: settings.maxTargets,
        maxSamplesPerSummary: settings.maxSamplesPerSummary,
        excludeDisruptedPeriods: settings.excludeDisruptedPeriods,
        disruptionPaddingMs: settings.disruptionPaddingMs,
        disruptionReasons: defaultDisruptionReasons,
      },
      (target, window) => this.incidentWindows(target, window),
    );
  }

  async onModuleInit(): Promise<void> {
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.config.baselines.refreshIntervalMs);
    this.timer.unref();
    // A first pass shortly after startup rather than immediately: telemetry batches
    // written by this same process should land before history is read back.
    const initial = setTimeout(() => void this.refresh(), 5_000);
    initial.unref();
    this.logger.log({
      event: 'baseline_refresh_scheduled',
      interval_ms: this.config.baselines.refreshIntervalMs,
      default_window: this.config.baselines.windows.default,
      fast_window: this.config.baselines.windows.fast,
      minimum_samples: this.config.baselines.minimumSamples,
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** One refresh cycle. Overlapping runs are skipped rather than queued. */
  async refresh(): Promise<BaselineRefreshResult | undefined> {
    if (this.running || this.stopped) return undefined;
    this.running = true;
    this.incidentCache.clear();
    try {
      const clusters = this.config.telemetryStorage.queryClusterScope;
      const result = await this.engine.refresh(clusters);
      const removed = await this.repository.deleteStale(
        new Date(Date.now() - this.config.baselines.staleAfterMs).toISOString(),
      );
      this.logger.log({
        event: 'baseline_refresh_completed',
        targets: result.targets,
        computed: result.computed,
        ready: result.ready,
        not_ready: result.notReady,
        excluded_ranges: result.excludedRanges,
        removed_stale: removed,
        duration_ms: result.durationMs,
      });
      return result;
    } catch (error) {
      // A failed refresh leaves the previous baselines in place; detection continues
      // against slightly older expected behaviour rather than stopping.
      this.logger.error({
        event: 'baseline_refresh_failed',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return undefined;
    } finally {
      this.running = false;
    }
  }

  private readonly incidentCache = new Map<
    string,
    Promise<readonly Incident[]>
  >();

  /**
   * Windows where Faultline already knew the workload was in trouble.
   *
   * Training on them would teach the baseline that a major outage is normal, so those
   * stretches are subtracted before the distribution is computed. Incidents are read
   * once per cluster and namespace per cycle rather than once per workload.
   */
  private async incidentWindows(
    target: BaselineTarget,
    window: TimeRange,
  ): Promise<readonly TimeRange[]> {
    if (!this.incidents) return [];
    const key = `${target.clusterId}|${target.namespace}`;
    const pending =
      this.incidentCache.get(key) ??
      Promise.all([
        this.incidents.listIncidents({
          clusterId: target.clusterId,
          namespace: target.namespace,
          severity: 'HIGH',
        }),
        this.incidents.listIncidents({
          clusterId: target.clusterId,
          namespace: target.namespace,
          severity: 'CRITICAL',
        }),
      ])
        .then(([high, critical]) => [...high, ...critical])
        .catch(() => []);
    this.incidentCache.set(key, pending);

    const windowStart = Date.parse(window.startTime);
    const windowEnd = Date.parse(window.endTime);
    return (await pending)
      .filter(
        (incident) =>
          affectsWorkload(incident, target.workload) &&
          Date.parse(incident.lastSeen) >= windowStart &&
          Date.parse(incident.firstSeen) <= windowEnd,
      )
      .map((incident) => ({
        startTime: incident.firstSeen,
        endTime: incident.resolvedAt ?? incident.lastSeen,
      }));
  }
}

function affectsWorkload(incident: Incident, workload: string): boolean {
  return [incident.primaryResource, ...incident.affectedResources].some(
    (resource) =>
      resource.workload === workload ||
      resource.pod?.startsWith(`${workload}-`) === true,
  );
}

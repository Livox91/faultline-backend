import type { IncidentClassification } from '@faultline/incidents';
import type {
  ReadinessReport,
  ReadinessStatus,
} from '@faultline/platform';
import {
  AnalyticsService,
  type IncidentTrendPoint,
} from './analytics';

export interface SystemSummaryInput {
  from: Date;
  to: Date;
}

/** Supplies observed application readiness; it may aggregate several Faultline services. */
export interface SystemHealthProvider {
  getSystemHealth(): Promise<readonly ReadinessReport[]>;
}

/** Adapts the existing process readiness service without reinterpreting its status. */
export class CurrentApplicationHealthProvider implements SystemHealthProvider {
  constructor(
    private readonly health: {
      getReadinessReport(): Promise<ReadinessReport>;
    },
  ) {}

  async getSystemHealth(): Promise<readonly ReadinessReport[]> {
    return [await this.health.getReadinessReport()];
  }
}

export interface RankedAffectedService {
  service: string;
  incidentCount: number;
}

export interface RankedIncidentCategory {
  classification: IncidentClassification;
  incidentCount: number;
}

export interface SystemSummaryReport {
  generatedAt: string;
  period: { from: string; to: string };
  health: {
    available: boolean;
    overallStatus: ReadinessStatus;
    healthyServices: number;
    degradedServices: number;
    unhealthyServices: number;
  };
  incidents: {
    total: number;
    critical: number;
    resolved: number;
    unresolved: number;
  };
  performance: {
    mttrMs: number | null;
    mttaMs: number | null;
  };
  topAffectedServices: readonly RankedAffectedService[];
  commonIncidentCategories: readonly RankedIncidentCategory[];
  trends: readonly IncidentTrendPoint[];
}

export interface SystemSummaryOptions {
  health?: SystemHealthProvider;
  now?: () => Date;
  rankingLimit?: number;
}

/** Management-facing composition over analytics and observed platform readiness. */
export class SystemSummaryService {
  private readonly now: () => Date;
  private readonly rankingLimit: number;

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly options: SystemSummaryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.rankingLimit = options.rankingLimit ?? 10;
    if (!Number.isSafeInteger(this.rankingLimit) || this.rankingLimit <= 0)
      throw new RangeError('Invalid system summary ranking limit');
  }

  async generateSystemSummary(
    input: SystemSummaryInput,
  ): Promise<SystemSummaryReport> {
    const [metrics, trends, healthReports] = await Promise.all([
      this.analytics.getIncidentMetrics(input),
      this.analytics.getIncidentTrends({ ...input, bucket: 'day' }),
      availableHealth(this.options.health),
    ]);

    return {
      generatedAt: this.now().toISOString(),
      period: {
        from: input.from.toISOString(),
        to: input.to.toISOString(),
      },
      health: summarizeHealth(healthReports),
      incidents: {
        total: metrics.totalIncidents,
        critical: metrics.criticalIncidents,
        resolved: metrics.resolvedIncidents,
        unresolved: metrics.openIncidents,
      },
      performance: {
        mttrMs: metrics.mttrMs,
        mttaMs: metrics.mttaMs,
      },
      topAffectedServices: rank(
        metrics.incidentsByService,
        this.rankingLimit,
        (service, incidentCount) => ({ service, incidentCount }),
      ),
      commonIncidentCategories: rank(
        metrics.incidentsByClassification,
        this.rankingLimit,
        (classification, incidentCount) => ({
          classification: classification as IncidentClassification,
          incidentCount,
        }),
      ),
      trends: trends.points,
    };
  }
}

async function availableHealth(
  provider?: SystemHealthProvider,
): Promise<readonly ReadinessReport[] | undefined> {
  if (!provider) return undefined;
  try {
    return await provider.getSystemHealth();
  } catch {
    return undefined;
  }
}

function summarizeHealth(
  reports: readonly ReadinessReport[] | undefined,
): SystemSummaryReport['health'] {
  if (!reports?.length)
    return {
      available: false,
      overallStatus: 'unavailable',
      healthyServices: 0,
      degradedServices: 0,
      unhealthyServices: 0,
    };
  const healthyServices = reports.filter((report) => report.status === 'ok').length;
  const degradedServices = reports.filter(
    (report) => report.status === 'degraded',
  ).length;
  const unhealthyServices = reports.filter(
    (report) => report.status === 'unavailable',
  ).length;
  return {
    available: true,
    overallStatus: unhealthyServices
      ? 'unavailable'
      : degradedServices
        ? 'degraded'
        : 'ok',
    healthyServices,
    degradedServices,
    unhealthyServices,
  };
}

function rank<T>(
  counts: Readonly<Record<string, number>>,
  limit: number,
  map: (name: string, count: number) => T,
): readonly T[] {
  return Object.entries(counts)
    .sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount || leftName.localeCompare(rightName),
    )
    .slice(0, limit)
    .map(([name, count]) => map(name, count));
}

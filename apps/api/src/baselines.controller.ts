import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApplicationLogger } from '@faultline/platform';
import {
  BASELINE_REPOSITORY,
  baselineWindows,
  findBaselineMetric,
  isBaselineWindow,
  type BaselineRepository,
  type BaselineStatus,
  type MetricBaseline,
} from '@faultline/baselines';
import {
  TelemetryQueryError,
  optionalEnum,
  optionalIdentifier,
  parseTelemetryResourceId,
  requiredIdentifier,
  type TelemetryScope,
} from '@faultline/telemetry';
import {
  TELEMETRY_SCOPE_RESOLVER,
  type TelemetryScopeResolver,
} from './telemetry-scope';

/**
 * Baseline inspection, for debugging and validating detection.
 *
 * When an operator asks "why did Faultline call that anomalous?", the answer is the
 * baseline the comparison used, so these endpoints expose it directly - including
 * BASELINE_NOT_READY rows, which explain the equally common question of why Faultline
 * said nothing at all.
 */
@Controller('baselines')
export class BaselinesController {
  constructor(
    @Inject(BASELINE_REPOSITORY)
    private readonly baselines: BaselineRepository,
    @Inject(TELEMETRY_SCOPE_RESOLVER)
    private readonly scopes: TelemetryScopeResolver,
    private readonly logger: ApplicationLogger,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Query() params: Record<string, unknown>) {
    const scope = await this.scopes.resolve();
    const filter = translate(() => ({
      // Cluster scoping is applied from the resolved scope, never from the query
      // string, exactly as for telemetry reads.
      ...clusterFilter(scope, params.clusterId),
      ...optionalField('namespace', params.namespace),
      ...optionalField('workload', params.workload),
      ...optionalField('metricName', params.metricName),
      ...parseWindow(params.window),
      ...parseStatus(params.status),
      limit: parseLimit(params.limit),
    }));
    const baselines = await this.read(() => this.baselines.list(filter));
    return {
      items: baselines.map(present),
      count: baselines.length,
    };
  }

  /**
   * One workload's baseline for one metric.
   *
   * `resourceId` uses the same encoding as the telemetry timeline
   * (`workload:<cluster>:<namespace>:<name>`), so a link from an incident's affected
   * resource leads straight here.
   */
  @Get(':resourceId/:metricName')
  @Header('Cache-Control', 'no-store')
  async get(
    @Param('resourceId') resourceId: string,
    @Param('metricName') metricName: string,
    @Query('window') windowValue: unknown,
  ) {
    const resource = parseTelemetryResourceId(resourceId);
    if (!resource || resource.scope !== 'workload' || !resource.namespace)
      throw new BadRequestException(
        'Expected a workload resource identifier: workload:<cluster>:<namespace>:<name>',
      );
    const scope = await this.scopes.resolve();
    assertScoped(scope, resource.clusterId);
    const metric = translate(() =>
      requiredIdentifier(metricName, 'metricName'),
    );
    const window = translate(() => parseWindow(windowValue));

    const matches = await this.read(() =>
      this.baselines.list({
        clusterId: resource.clusterId,
        namespace: resource.namespace!,
        workload: resource.name,
        metricName: metric,
        ...window,
        limit: baselineWindows.length,
      }),
    );
    if (!matches.length)
      throw new NotFoundException(
        findBaselineMetric(metric)
          ? 'No baseline has been computed for this workload and metric yet'
          : 'Unknown baseline metric',
      );
    return {
      resourceId,
      metricName: metric,
      // One row per window: a metric may be baselined over more than one horizon.
      items: matches.map(present),
    };
  }

  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      this.logger.error({ event: 'baseline_query_failed' });
      throw new ServiceUnavailableException('Baseline storage is unavailable');
    }
  }
}

/**
 * Flattens the stored shape for readers.
 *
 * `status` leads because it decides whether the statistics mean anything, and
 * `sampleCount` and `excludedRanges` sit beside them because they are how an operator
 * judges whether to trust the numbers.
 */
function present(baseline: MetricBaseline) {
  return {
    clusterId: baseline.clusterId,
    namespace: baseline.namespace,
    workload: baseline.workload,
    resourceId: `workload:${encodeURIComponent(baseline.clusterId)}:${encodeURIComponent(baseline.namespace)}:${encodeURIComponent(baseline.workload)}`,
    resourceType: baseline.resourceType,
    metricName: baseline.metricName,
    label: findBaselineMetric(baseline.metricName)?.label,
    window: baseline.window,
    season: baseline.season,
    status: baseline.status,
    sampleCount: baseline.sampleCount,
    unit: baseline.unit,
    windowStart: baseline.windowStart,
    windowEnd: baseline.windowEnd,
    excludedRanges: baseline.excludedRanges,
    updatedAt: baseline.updatedAt,
    ...(baseline.statistics
      ? {
          mean: baseline.statistics.mean,
          min: baseline.statistics.min,
          max: baseline.statistics.max,
          standardDeviation: baseline.statistics.standardDeviation,
          p50: baseline.statistics.p50,
          p95: baseline.statistics.p95,
          p99: baseline.statistics.p99,
        }
      : {}),
  };
}

function clusterFilter(
  scope: TelemetryScope,
  requested: unknown,
): { clusterId?: string; clusterIds?: readonly string[] } {
  if (requested !== undefined && requested !== '') {
    const clusterId = requiredIdentifier(requested, 'clusterId');
    assertScoped(scope, clusterId);
    return { clusterId };
  }
  return scope.mode === 'clusters' ? { clusterIds: scope.clusterIds } : {};
}

function assertScoped(scope: TelemetryScope, clusterId: string): void {
  if (scope.mode === 'clusters' && !scope.clusterIds.includes(clusterId))
    throw new ForbiddenException('Cluster is outside the authorized scope');
}

function optionalField(
  name: 'namespace' | 'workload' | 'metricName',
  value: unknown,
): Record<string, string> {
  const parsed = optionalIdentifier(value, name);
  return parsed ? { [name]: parsed } : {};
}

function parseWindow(value: unknown) {
  if (value === undefined || value === '') return {};
  if (!isBaselineWindow(value))
    throw new TelemetryQueryError('Invalid window filter');
  return { window: value };
}

function parseStatus(value: unknown) {
  const status = optionalEnum(
    value,
    ['READY', 'BASELINE_NOT_READY'] as const,
    'status',
  );
  return status ? { status: status as BaselineStatus } : {};
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === '') return 200;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TelemetryQueryError('Invalid limit filter');
  return Math.min(limit, 1000);
}

function translate<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TelemetryQueryError)
      throw new BadRequestException(error.message);
    throw error;
  }
}

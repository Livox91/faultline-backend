import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Param,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  TELEMETRY_STORE,
  TelemetryQueryError,
  TelemetryScopeError,
  encodeTelemetryResourceId,
  validateKubernetesEventQuery,
  validateLogSearchQuery,
  validateMetricQuery,
  validateResourceTimelineQuery,
  type TelemetryQueryLimits,
  type TelemetryStore,
} from '@faultline/telemetry';
import {
  TELEMETRY_SCOPE_RESOLVER,
  resolveQueryCluster,
  type TelemetryScopeResolver,
} from './telemetry-scope';

/**
 * Read-only telemetry investigation endpoints.
 *
 * Everything a caller sends is a filter value. Query shape, table choice and result
 * bounds are decided here and in the store, so there is no way to express an arbitrary
 * query, and no endpoint accepts SQL.
 */
@Controller('telemetry')
export class TelemetryController {
  private readonly limits: TelemetryQueryLimits;

  constructor(
    @Inject(TELEMETRY_STORE) private readonly store: TelemetryStore,
    @Inject(TELEMETRY_SCOPE_RESOLVER)
    private readonly scopes: TelemetryScopeResolver,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
    private readonly logger: ApplicationLogger,
  ) {
    this.limits = config.telemetryStorage.queryLimits;
  }

  @Get('logs')
  @Header('Cache-Control', 'no-store')
  async logs(@Query() params: Record<string, unknown>) {
    const scope = await this.scopes.resolve();
    const query = translate(() =>
      validateLogSearchQuery(
        {
          ...params,
          clusterId: resolveQueryCluster(scope, params.clusterId),
        },
        this.limits,
      ),
    );
    const page = await this.read('logs', () =>
      this.store.searchLogs(scope, query),
    );
    return {
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      query: {
        clusterId: query.clusterId,
        startTime: query.startTime,
        endTime: query.endTime,
        limit: query.limit,
      },
    };
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(@Query() params: Record<string, unknown>) {
    const scope = await this.scopes.resolve();
    const query = translate(() =>
      validateMetricQuery(
        {
          ...params,
          clusterId: resolveQueryCluster(scope, params.clusterId),
        },
        this.limits,
      ),
    );
    const page = await this.read('metrics', () =>
      this.store.queryMetrics(scope, query),
    );
    return {
      items: page.items,
      query: {
        clusterId: query.clusterId,
        metricName: query.metricName,
        startTime: query.startTime,
        endTime: query.endTime,
        bucketMs: query.bucketMs,
        aggregations: query.aggregations,
      },
    };
  }

  @Get('kubernetes-events')
  @Header('Cache-Control', 'no-store')
  async kubernetesEvents(@Query() params: Record<string, unknown>) {
    const scope = await this.scopes.resolve();
    const query = translate(() =>
      validateKubernetesEventQuery(
        {
          ...params,
          clusterId: resolveQueryCluster(scope, params.clusterId),
        },
        this.limits,
      ),
    );
    const page = await this.read('kubernetes-events', () =>
      this.store.searchKubernetesEvents(scope, query),
    );
    return {
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      query: {
        clusterId: query.clusterId,
        startTime: query.startTime,
        endTime: query.endTime,
        limit: query.limit,
      },
    };
  }

  private async read<T>(kind: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TelemetryScopeError)
        throw new ForbiddenException(error.message);
      if (error instanceof TelemetryQueryError)
        throw new BadRequestException(error.message);
      this.logger.error({ event: 'telemetry_query_failed', kind });
      // Never leak adapter internals; telemetry history being down is a 503, not a 500.
      throw new ServiceUnavailableException('Telemetry storage is unavailable');
    }
  }
}

/**
 * Resource-scoped view of everything Faultline retained about a workload, pod,
 * container or node in a window: "what happened here between 12:00 and 12:15".
 */
@Controller('resources')
export class ResourceTimelineController {
  private readonly limits: TelemetryQueryLimits;

  constructor(
    @Inject(TELEMETRY_STORE) private readonly store: TelemetryStore,
    @Inject(TELEMETRY_SCOPE_RESOLVER)
    private readonly scopes: TelemetryScopeResolver,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
    private readonly logger: ApplicationLogger,
  ) {
    this.limits = config.telemetryStorage.queryLimits;
  }

  @Get(':resourceId/timeline')
  @Header('Cache-Control', 'no-store')
  async timeline(
    @Param('resourceId') resourceId: string,
    @Query() params: Record<string, unknown>,
  ) {
    const scope = await this.scopes.resolve();
    const query = translate(() =>
      validateResourceTimelineQuery({ ...params, resourceId }, this.limits),
    );
    try {
      const timeline = await this.store.getResourceTimeline(scope, query);
      return {
        ...timeline,
        resourceId: encodeTelemetryResourceId(timeline.resource),
      };
    } catch (error) {
      if (error instanceof TelemetryScopeError)
        throw new ForbiddenException(error.message);
      if (error instanceof TelemetryQueryError)
        throw new BadRequestException(error.message);
      this.logger.error({ event: 'telemetry_timeline_failed' });
      throw new ServiceUnavailableException('Telemetry storage is unavailable');
    }
  }
}

/** Validation errors are client errors; anything else keeps its own mapping. */
function translate<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TelemetryQueryError)
      throw new BadRequestException(error.message);
    if (error instanceof TelemetryScopeError)
      throw new ForbiddenException(error.message);
    throw error;
  }
}

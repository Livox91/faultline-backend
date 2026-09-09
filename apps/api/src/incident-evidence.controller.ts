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
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  INCIDENT_REPOSITORY,
  type AnomalyAffectedResource,
  type Incident,
  type IncidentRepository,
} from '@faultline/incidents';
import {
  TELEMETRY_STORE,
  TelemetryQueryError,
  TelemetryScopeError,
  defaultTimelineMetricNames,
  encodeTelemetryResourceId,
  errorSeverities,
  parseLimit,
  type TelemetryQueryLimits,
  type TelemetryResourceRef,
  type TelemetryStore,
} from '@faultline/telemetry';
import {
  TELEMETRY_SCOPE_RESOLVER,
  type TelemetryScopeResolver,
} from './telemetry-scope';

const DEFAULT_LEAD_MS = 120_000;
const DEFAULT_TRAIL_MS = 300_000;

/**
 * Incident to telemetry bridge.
 *
 * PostgreSQL keeps the incident and small structured evidence entries: anomaly IDs,
 * summaries and the telemetry event IDs that produced them. It never stores the
 * telemetry itself. This endpoint turns an incident into what a diagnosis system needs
 * to go and fetch that history: an evidence window, the resources involved, the
 * referenced event IDs, and the exact query context used to retrieve it.
 */
@Controller('incidents')
export class IncidentEvidenceController {
  private readonly limits: TelemetryQueryLimits;

  constructor(
    @Inject(INCIDENT_REPOSITORY)
    private readonly incidents: IncidentRepository,
    @Inject(TELEMETRY_STORE) private readonly store: TelemetryStore,
    @Inject(TELEMETRY_SCOPE_RESOLVER)
    private readonly scopes: TelemetryScopeResolver,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
    private readonly logger: ApplicationLogger,
  ) {
    this.limits = config.telemetryStorage.queryLimits;
  }

  @Get(':id/evidence')
  @Header('Cache-Control', 'no-store')
  async evidence(
    @Param('id') id: string,
    @Query('leadMs') leadValue: unknown,
    @Query('trailMs') trailValue: unknown,
    @Query('limit') limitValue: unknown,
  ) {
    const incident = await this.incidents.getIncident(id);
    if (!incident) throw new NotFoundException('Incident not found');
    const scope = await this.scopes.resolve();
    const lead = padding(leadValue, DEFAULT_LEAD_MS, 'leadMs');
    const trail = padding(trailValue, DEFAULT_TRAIL_MS, 'trailMs');
    const limit = parseLimit(limitValue, this.limits);
    const window = evidenceWindow(incident, lead, trail, this.limits);
    const resources = incidentResources(incident);
    const eventIds = [
      ...new Set(
        incident.evidence
          .map((entry) => entry.eventId)
          .filter((eventId): eventId is string => Boolean(eventId)),
      ),
    ];
    const primary = resources[0]!;
    const queryContext = {
      clusterId: incident.clusterId,
      window,
      resourceIds: resources.map(encodeTelemetryResourceId),
      severity: errorSeverities,
      metricNames: defaultTimelineMetricNames,
      limit,
    };

    try {
      const [logs, kubernetesEvents, timeline] = await Promise.all([
        this.store.searchLogs(scope, {
          clusterId: incident.clusterId,
          ...(incident.namespace ? { namespace: incident.namespace } : {}),
          ...(primary.scope === 'workload' ? { workload: primary.name } : {}),
          severity: errorSeverities,
          ...window,
          limit,
        }),
        this.store.searchKubernetesEvents(scope, {
          clusterId: incident.clusterId,
          ...(incident.namespace ? { namespace: incident.namespace } : {}),
          type: 'Warning',
          ...window,
          limit,
        }),
        this.store.getResourceTimeline(scope, {
          resource: primary,
          ...window,
          limit,
          metricNames: defaultTimelineMetricNames,
        }),
      ]);
      return {
        incidentId: incident.id,
        clusterId: incident.clusterId,
        classification: incident.classification,
        status: incident.status,
        window,
        resources: resources.map((resource) => ({
          resourceId: encodeTelemetryResourceId(resource),
          ...resource,
        })),
        // Structured evidence already stored in PostgreSQL; telemetry stays in ClickHouse.
        anomalyEvidence: incident.evidence,
        eventIds,
        queryContext,
        telemetry: {
          errorLogs: logs.items,
          kubernetesEvents: kubernetesEvents.items,
          metrics: timeline.metrics,
        },
      };
    } catch (error) {
      if (error instanceof TelemetryScopeError)
        throw new ForbiddenException(error.message);
      if (error instanceof TelemetryQueryError)
        throw new BadRequestException(error.message);
      this.logger.error({
        event: 'incident_evidence_lookup_failed',
        incident_id: incident.id,
      });
      throw new ServiceUnavailableException('Telemetry storage is unavailable');
    }
  }
}

function padding(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === '') return fallback;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new BadRequestException(`Invalid ${field}`);
  return milliseconds;
}

/**
 * The window the incident actually occupied, padded on both sides.
 *
 * A long-running incident can outlast the maximum query range, so the window is clipped
 * to end at `lastSeen + trail`: the minutes around the most recent activity are the ones
 * worth reading, and an unbounded window is exactly what query safety forbids.
 */
function evidenceWindow(
  incident: Incident,
  leadMs: number,
  trailMs: number,
  limits: TelemetryQueryLimits,
): { startTime: string; endTime: string } {
  const endMs = Date.parse(incident.resolvedAt ?? incident.lastSeen) + trailMs;
  const requestedStartMs = Date.parse(incident.firstSeen) - leadMs;
  const startMs = Math.max(requestedStartMs, endMs - limits.maxTimeRangeMs);
  return {
    startTime: new Date(Math.min(startMs, endMs - 1)).toISOString(),
    endTime: new Date(endMs).toISOString(),
  };
}

/** Primary resource first: the timeline and metric samples follow it. */
function incidentResources(incident: Incident): TelemetryResourceRef[] {
  const refs = [incident.primaryResource, ...incident.affectedResources]
    .map(toResourceRef)
    .filter((ref): ref is TelemetryResourceRef => ref !== undefined);
  const seen = new Set<string>();
  const unique = refs.filter((ref) => {
    const key = encodeTelemetryResourceId(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length
    ? unique
    : [
        {
          scope: 'namespace',
          clusterId: incident.clusterId,
          name: incident.namespace ?? 'default',
        },
      ];
}

function toResourceRef(
  resource: AnomalyAffectedResource,
): TelemetryResourceRef | undefined {
  switch (resource.scope) {
    case 'container':
      return resource.namespace && resource.pod && resource.container
        ? {
            scope: 'container',
            clusterId: resource.clusterId,
            namespace: resource.namespace,
            name: resource.pod,
            container: resource.container,
          }
        : undefined;
    case 'pod':
      return resource.namespace && resource.pod
        ? {
            scope: 'pod',
            clusterId: resource.clusterId,
            namespace: resource.namespace,
            name: resource.pod,
          }
        : undefined;
    case 'deployment':
      return resource.workload
        ? {
            scope: 'workload',
            clusterId: resource.clusterId,
            ...(resource.namespace ? { namespace: resource.namespace } : {}),
            name: resource.workload,
          }
        : undefined;
    case 'node':
      return resource.node
        ? {
            scope: 'node',
            clusterId: resource.clusterId,
            name: resource.node,
          }
        : undefined;
  }
}

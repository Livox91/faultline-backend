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
} from '@nestjs/common';
import {
  INCIDENT_REPOSITORY,
  type IncidentClassification,
  type IncidentFilter,
  type IncidentRepository,
  type IncidentSeverity,
  type IncidentStatus,
} from '@faultline/incidents';
import {
  hasProjectAccess,
  isAdmin,
  type AuthenticatedUser,
} from '@faultline/auth';
import { scopeAllowsCluster } from '@faultline/telemetry';
import {
  TELEMETRY_SCOPE_RESOLVER,
  scopedClusterIds,
  type TelemetryScopeResolver,
} from './telemetry-scope';
import { CurrentUser } from './auth/context';

const statuses = new Set<IncidentStatus>(['OPEN', 'ACTIVE', 'RESOLVED']);
const severities = new Set<IncidentSeverity>([
  'INFO',
  'WARNING',
  'HIGH',
  'CRITICAL',
]);
const classifications = new Set<IncidentClassification>([
  'MEMORY_EXHAUSTION',
  'RESOURCE_SATURATION',
  'WORKLOAD_CRASHING',
  'DEPLOYMENT_DEGRADATION',
  'NODE_FAILURE',
  'WORKLOAD_CONFIGURATION_FAILURE',
  'SCHEDULING_FAILURE',
  'APPLICATION_DEGRADATION',
  'APPLICATION_DEPENDENCY_FAILURE',
]);

function optional(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`Invalid ${field} filter`);
  return value.trim();
}

@Controller('incidents')
export class IncidentsController {
  constructor(
    @Inject(INCIDENT_REPOSITORY)
    private readonly incidents: IncidentRepository,
    @Inject(TELEMETRY_SCOPE_RESOLVER)
    private readonly scopes: TelemetryScopeResolver,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cluster') cluster: unknown,
    @Query('namespace') namespace: unknown,
    @Query('status') statusValue: unknown,
    @Query('severity') severityValue: unknown,
    @Query('classification') classificationValue: unknown,
  ) {
    const status = optional(statusValue, 'status')?.toUpperCase();
    const severity = optional(severityValue, 'severity')?.toUpperCase();
    const classification = optional(
      classificationValue,
      'classification',
    )?.toUpperCase();
    if (status && !statuses.has(status as IncidentStatus))
      throw new BadRequestException('Invalid status filter');
    if (severity && !severities.has(severity as IncidentSeverity))
      throw new BadRequestException('Invalid severity filter');
    if (
      classification &&
      !classifications.has(classification as IncidentClassification)
    )
      throw new BadRequestException('Invalid classification filter');

    const scope = await this.scopes.resolve(user);
    const requestedCluster = optional(cluster, 'cluster');
    // A cluster named in the query is a filter, not a claim. Asking for one outside the
    // caller's scope is refused outright rather than quietly answered with an empty
    // list, because the two are different facts and the caller should be told which.
    if (requestedCluster && !scopeAllowsCluster(scope, requestedCluster))
      throw new ForbiddenException('You do not have access to this project');

    const filter: IncidentFilter = {
      // The scope is applied as a filter of its own, inside the query, so the listing
      // is bounded even when the caller named no cluster at all.
      ...(scopedClusterIds(scope) ? { clusterIds: scopedClusterIds(scope) } : {}),
      clusterId: requestedCluster,
      namespace: optional(namespace, 'namespace'),
      status: status as IncidentStatus | undefined,
      severity: severity as IncidentSeverity | undefined,
      classification: classification as IncidentClassification | undefined,
    };
    return this.incidents.listIncidents(filter);
  }

  /**
   * One incident, if the caller's projects include the one it belongs to.
   *
   * An incident outside the caller's projects answers 404, not 403: the id is
   * unguessable and its existence is itself information, so "no such incident, as far
   * as you are concerned" is the honest answer. Project ids, by contrast, are chosen by
   * an Admin and often guessable, so naming one you cannot reach answers 403 - see
   * `list` above and the projects controller.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const incident = await this.incidents.getIncident(id);
    if (!incident) throw new NotFoundException('Incident not found');
    if (!isAdmin(user) && !hasProjectAccess(user, incident.clusterId))
      throw new NotFoundException('Incident not found');
    return incident;
  }
}

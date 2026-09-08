import {
  BadRequestException,
  Controller,
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
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
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
    const filter: IncidentFilter = {
      clusterId: optional(cluster, 'cluster'),
      namespace: optional(namespace, 'namespace'),
      status: status as IncidentStatus | undefined,
      severity: severity as IncidentSeverity | undefined,
      classification: classification as IncidentClassification | undefined,
    };
    return this.incidents.listIncidents(filter);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id') id: string) {
    const incident = await this.incidents.getIncident(id);
    if (!incident) throw new NotFoundException('Incident not found');
    return incident;
  }
}

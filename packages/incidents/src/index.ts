export type AnomalyClassification =
  | 'OOM_KILLED'
  | 'CRASH_LOOP'
  | 'HIGH_MEMORY_UTILIZATION'
  | 'HIGH_CPU_UTILIZATION'
  | 'POD_NOT_READY'
  | 'DEPLOYMENT_DEGRADED'
  | 'FAILED_SCHEDULING'
  | 'IMAGE_PULL_FAILURE'
  | 'FAILED_MOUNT'
  | 'NODE_NOT_READY';

export type OperationalSeverity = 'INFO' | 'WARNING' | 'HIGH' | 'CRITICAL';
export type OperationalStatus = 'OPEN' | 'ACTIVE' | 'RESOLVED';
export type AnomalySeverity = OperationalSeverity;
export type AnomalyStatus = OperationalStatus;

export interface AnomalyAffectedResource {
  scope: 'container' | 'pod' | 'deployment' | 'node';
  clusterId: string;
  namespace?: string;
  workload?: string;
  workloadKind?: string;
  workloadUid?: string;
  pod?: string;
  podUid?: string;
  container?: string;
  node?: string;
}

export interface AnomalyEvidence {
  type: 'telemetry' | 'resource-state' | 'calculation';
  summary: string;
  timestamp: string;
  eventId?: string;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

/** A diagnostic signal. Correlation may group several anomalies into one Incident. */
export interface Anomaly {
  anomalyId: string;
  dedupeKey: string;
  ruleId: string;
  classification: AnomalyClassification;
  severity: AnomalySeverity;
  confidence: number;
  clusterId: string;
  affectedResource: AnomalyAffectedResource;
  timestamp: string;
  summary: string;
  evidence: readonly AnomalyEvidence[];
  status: AnomalyStatus;
  firstSeen: string;
  lastSeen: string;
}

export type IncidentClassification =
  | 'MEMORY_EXHAUSTION'
  | 'RESOURCE_SATURATION'
  | 'WORKLOAD_CRASHING'
  | 'DEPLOYMENT_DEGRADATION'
  | 'NODE_FAILURE'
  | 'WORKLOAD_CONFIGURATION_FAILURE'
  | 'SCHEDULING_FAILURE';
export type IncidentSeverity = OperationalSeverity;
export type IncidentStatus = OperationalStatus;

export interface IncidentEvidence extends AnomalyEvidence {
  anomalyId: string;
  classification: AnomalyClassification;
}

export interface IncidentTimelineEntry {
  id: string;
  timestamp: string;
  type: 'ANOMALY_OPENED' | 'ANOMALY_ACTIVE' | 'ANOMALY_RESOLVED';
  anomalyId: string;
  classification: AnomalyClassification;
  severity: AnomalySeverity;
  summary: string;
}

/** Framework and persistence independent operational incident aggregate. */
export interface Incident {
  id: string;
  correlationKey: string;
  clusterId: string;
  namespace?: string;
  primaryResource: AnomalyAffectedResource;
  affectedResources: readonly AnomalyAffectedResource[];
  classification: IncidentClassification;
  title: string;
  summary: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  /** Deterministic evidence score, not a probability or mathematical certainty. */
  confidence: number;
  firstSeen: string;
  lastSeen: string;
  resolvedAt?: string;
  stabilizationStartedAt?: string;
  anomalies: readonly Anomaly[];
  evidence: readonly IncidentEvidence[];
  timeline: readonly IncidentTimelineEntry[];
}

export interface IncidentFilter {
  clusterId?: string;
  namespace?: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  classification?: IncidentClassification;
}

export interface ActiveIncidentLookup {
  correlationKey: string;
  classifications?: readonly IncidentClassification[];
  since?: string;
}

export interface IncidentRepository {
  createIncident(incident: Incident): Promise<Incident>;
  updateIncident(incident: Incident): Promise<Incident>;
  findActiveIncident(
    query: ActiveIncidentLookup,
  ): Promise<Incident | undefined>;
  findByAnomalyId(anomalyId: string): Promise<Incident | undefined>;
  getIncident(id: string): Promise<Incident | undefined>;
  resolveIncident(
    id: string,
    resolvedAt: string,
  ): Promise<Incident | undefined>;
  listActiveIncidents(): Promise<readonly Incident[]>;
  listIncidents(filter?: IncidentFilter): Promise<readonly Incident[]>;
}

export const INCIDENT_REPOSITORY = Symbol('faultline.incident-repository');

/** Temporary bounded repository. Replace this composition provider with durable storage. */
export class InMemoryIncidentRepository implements IncidentRepository {
  private readonly incidents = new Map<string, Incident>();

  constructor(private readonly capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new Error('Invalid incident repository capacity');
  }

  async createIncident(incident: Incident): Promise<Incident> {
    if (this.incidents.has(incident.id))
      throw new Error('Incident already exists');
    if (this.incidents.size >= this.capacity)
      this.incidents.delete(this.incidents.keys().next().value!);
    this.incidents.set(incident.id, structuredClone(incident));
    return structuredClone(incident);
  }

  async updateIncident(incident: Incident): Promise<Incident> {
    if (!this.incidents.has(incident.id)) throw new Error('Incident not found');
    this.incidents.delete(incident.id);
    this.incidents.set(incident.id, structuredClone(incident));
    return structuredClone(incident);
  }

  async findActiveIncident(
    query: ActiveIncidentLookup,
  ): Promise<Incident | undefined> {
    const since = query.since
      ? Date.parse(query.since)
      : Number.NEGATIVE_INFINITY;
    const match = [...this.incidents.values()]
      .reverse()
      .find(
        (incident) =>
          incident.status !== 'RESOLVED' &&
          incident.correlationKey === query.correlationKey &&
          Date.parse(incident.lastSeen) >= since &&
          (!query.classifications?.length ||
            query.classifications.includes(incident.classification)),
      );
    return match ? structuredClone(match) : undefined;
  }

  async findByAnomalyId(anomalyId: string): Promise<Incident | undefined> {
    const match = [...this.incidents.values()].find((incident) =>
      incident.anomalies.some((anomaly) => anomaly.anomalyId === anomalyId),
    );
    return match ? structuredClone(match) : undefined;
  }

  async getIncident(id: string): Promise<Incident | undefined> {
    const incident = this.incidents.get(id);
    return incident ? structuredClone(incident) : undefined;
  }

  async resolveIncident(
    id: string,
    resolvedAt: string,
  ): Promise<Incident | undefined> {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;
    return this.updateIncident({
      ...incident,
      status: 'RESOLVED',
      resolvedAt,
    });
  }

  async listActiveIncidents(): Promise<readonly Incident[]> {
    return this.listIncidents().then((incidents) =>
      incidents.filter((incident) => incident.status !== 'RESOLVED'),
    );
  }

  async listIncidents(
    filter: IncidentFilter = {},
  ): Promise<readonly Incident[]> {
    return [...this.incidents.values()]
      .filter(
        (incident) =>
          (!filter.clusterId || incident.clusterId === filter.clusterId) &&
          (!filter.namespace || incident.namespace === filter.namespace) &&
          (!filter.status || incident.status === filter.status) &&
          (!filter.severity || incident.severity === filter.severity) &&
          (!filter.classification ||
            incident.classification === filter.classification),
      )
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      .map((incident) => structuredClone(incident));
  }
}

let temporaryRepository: IncidentRepository | undefined;
export function getDevelopmentIncidentRepository(): IncidentRepository {
  return (temporaryRepository ??= new InMemoryIncidentRepository());
}

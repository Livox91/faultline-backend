import { randomUUID } from 'node:crypto';
import type {
  Anomaly,
  AnomalyAffectedResource,
  AnomalyClassification,
  Incident,
  IncidentClassification,
  IncidentEvidence,
  IncidentRepository,
  IncidentSeverity,
  IncidentTimelineEntry,
} from '@faultline/incidents';
import type { IncidentCorrelationConfig } from '@faultline/platform';
import type { IncidentChange, IncidentCorrelator } from './contracts';
import { correlationKey, correlationResource } from './ownership';

const severityRank: Record<IncidentSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};
const memory = new Set<AnomalyClassification>([
  'HIGH_MEMORY_UTILIZATION',
  'OOM_KILLED',
]);
const availability = new Set<AnomalyClassification>([
  'CRASH_LOOP',
  'POD_NOT_READY',
  'DEPLOYMENT_DEGRADED',
]);

function resourceKey(resource: AnomalyAffectedResource): string {
  const identity =
    resource.scope === 'node'
      ? resource.node
      : resource.scope === 'deployment'
        ? (resource.workloadUid ?? resource.workload)
        : (resource.podUid ?? resource.pod);
  return JSON.stringify([
    resource.clusterId,
    resource.scope,
    resource.namespace ?? '',
    identity ?? '',
    resource.container ?? '',
  ]);
}

function related(incident: Incident, anomaly: Anomaly): boolean {
  const classes = new Set(
    incident.anomalies.map((item) => item.classification),
  );
  if (classes.has(anomaly.classification)) return true;
  if (
    memory.has(anomaly.classification) &&
    [...classes].some((item) => memory.has(item))
  )
    return true;
  if (
    availability.has(anomaly.classification) &&
    [...classes].some((item) => availability.has(item))
  )
    return true;
  // Pod availability is supporting evidence for an active memory failure.
  if (
    anomaly.classification === 'POD_NOT_READY' &&
    [...classes].some((item) => memory.has(item))
  )
    return true;
  if (memory.has(anomaly.classification) && classes.has('POD_NOT_READY'))
    return true;
  if (
    anomaly.classification === 'NODE_NOT_READY' &&
    classes.has('POD_NOT_READY')
  )
    return true;
  if (
    anomaly.classification === 'POD_NOT_READY' &&
    classes.has('NODE_NOT_READY')
  )
    return true;
  return false;
}

function title(classification: IncidentClassification): string {
  return classification
    .toLowerCase()
    .split('_')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function uniquePods(
  anomalies: readonly Anomaly[],
  classification?: AnomalyClassification,
): number {
  return new Set(
    anomalies
      .filter(
        (item) => !classification || item.classification === classification,
      )
      .map((item) => item.affectedResource.podUid ?? item.affectedResource.pod)
      .filter(Boolean),
  ).size;
}

function classify(anomalies: readonly Anomaly[]): IncidentClassification {
  const classes = new Set(anomalies.map((item) => item.classification));
  if (classes.has('NODE_NOT_READY')) return 'NODE_FAILURE';
  if (classes.has('OOM_KILLED') || classes.has('HIGH_MEMORY_UTILIZATION'))
    return 'MEMORY_EXHAUSTION';
  if (classes.has('DEPLOYMENT_DEGRADED')) return 'DEPLOYMENT_DEGRADATION';
  if (classes.has('CRASH_LOOP') || classes.has('POD_NOT_READY'))
    return 'WORKLOAD_CRASHING';
  if (classes.has('IMAGE_PULL_FAILURE') || classes.has('FAILED_MOUNT'))
    return 'WORKLOAD_CONFIGURATION_FAILURE';
  if (classes.has('FAILED_SCHEDULING')) return 'SCHEDULING_FAILURE';
  return 'RESOURCE_SATURATION';
}

function confidence(
  classification: IncidentClassification,
  anomalies: readonly Anomaly[],
): number {
  const classes = new Set(anomalies.map((item) => item.classification));
  if (classification === 'MEMORY_EXHAUSTION') {
    const highMemory = classes.has('HIGH_MEMORY_UTILIZATION');
    const oom = classes.has('OOM_KILLED');
    const restart = anomalies.some((item) =>
      item.evidence.some(
        (evidence) =>
          evidence.summary.toLowerCase().includes('restart count increased') ||
          Number(evidence.attributes?.delta) > 0,
      ),
    );
    if (highMemory && oom && restart) return 0.98;
    if (highMemory && oom) return 0.9;
    if (oom) return 0.8;
    return 0.45;
  }
  if (classification === 'WORKLOAD_CRASHING') {
    if (classes.has('CRASH_LOOP') && classes.has('POD_NOT_READY')) return 0.92;
    if (classes.has('CRASH_LOOP')) return 0.75;
    return uniquePods(anomalies, 'POD_NOT_READY') > 1 ? 0.75 : 0.55;
  }
  if (classification === 'DEPLOYMENT_DEGRADATION')
    return uniquePods(anomalies, 'POD_NOT_READY') > 1 ? 0.95 : 0.8;
  if (classification === 'NODE_FAILURE')
    return uniquePods(anomalies, 'POD_NOT_READY') > 1 ? 0.97 : 0.85;
  if (classification === 'WORKLOAD_CONFIGURATION_FAILURE')
    return uniquePods(anomalies) > 1 ? 0.95 : 0.8;
  if (classification === 'SCHEDULING_FAILURE') return 0.8;
  return Math.max(0.5, ...anomalies.map((item) => item.confidence * 0.75));
}

function deriveSeverity(
  classification: IncidentClassification,
  anomalies: readonly Anomaly[],
): IncidentSeverity {
  let severity = anomalies.reduce<IncidentSeverity>(
    (highest, item) =>
      severityRank[item.severity] > severityRank[highest]
        ? item.severity
        : highest,
    'INFO',
  );
  if (
    (classification === 'NODE_FAILURE' ||
      classification === 'DEPLOYMENT_DEGRADATION') &&
    uniquePods(anomalies, 'POD_NOT_READY') > 1
  )
    severity = 'CRITICAL';
  return severity;
}

function timelineEntry(anomaly: Anomaly): IncidentTimelineEntry {
  return {
    id: `${anomaly.anomalyId}:${anomaly.status}:${anomaly.timestamp}`,
    timestamp: anomaly.timestamp,
    type:
      anomaly.status === 'OPEN'
        ? 'ANOMALY_OPENED'
        : anomaly.status === 'ACTIVE'
          ? 'ANOMALY_ACTIVE'
          : 'ANOMALY_RESOLVED',
    anomalyId: anomaly.anomalyId,
    classification: anomaly.classification,
    severity: anomaly.severity,
    summary: anomaly.summary,
  };
}

function rebuild(incident: Incident, anomaly: Anomaly): Incident {
  const previous = incident.anomalies.findIndex(
    (item) => item.anomalyId === anomaly.anomalyId,
  );
  const anomalies = [...incident.anomalies];
  if (previous >= 0) anomalies[previous] = anomaly;
  else anomalies.push(anomaly);
  const classification = classify(anomalies);
  const affectedResources = [...incident.affectedResources];
  if (
    !affectedResources.some(
      (item) => resourceKey(item) === resourceKey(anomaly.affectedResource),
    )
  )
    affectedResources.push(anomaly.affectedResource);
  const evidence = [...incident.evidence];
  for (const item of anomaly.evidence) {
    const next: IncidentEvidence = {
      ...item,
      anomalyId: anomaly.anomalyId,
      classification: anomaly.classification,
    };
    if (
      !evidence.some(
        (candidate) =>
          candidate.anomalyId === next.anomalyId &&
          candidate.eventId === next.eventId &&
          candidate.timestamp === next.timestamp &&
          candidate.summary === next.summary,
      )
    )
      evidence.push(next);
  }
  evidence.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const entry = timelineEntry(anomaly);
  const timeline = incident.timeline.some((item) => item.id === entry.id)
    ? [...incident.timeline]
    : [...incident.timeline, entry];
  timeline.sort(
    (a, b) =>
      Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
      a.id.localeCompare(b.id),
  );
  const active = anomalies.some((item) => item.status !== 'RESOLVED');
  const primaryResource =
    classification === 'NODE_FAILURE'
      ? correlationResource(
          anomalies.find((item) => item.classification === 'NODE_NOT_READY')!
            .affectedResource,
        )
      : incident.primaryResource;
  return {
    ...incident,
    primaryResource,
    affectedResources,
    classification,
    title: title(classification),
    summary: `${title(classification)} supported by ${anomalies.length} anomaly signal${anomalies.length === 1 ? '' : 's'}`,
    severity: deriveSeverity(classification, anomalies),
    confidence: confidence(classification, anomalies),
    status: 'ACTIVE',
    firstSeen:
      Date.parse(anomaly.firstSeen) < Date.parse(incident.firstSeen)
        ? anomaly.firstSeen
        : incident.firstSeen,
    lastSeen:
      Date.parse(anomaly.lastSeen) > Date.parse(incident.lastSeen)
        ? anomaly.lastSeen
        : incident.lastSeen,
    resolvedAt: undefined,
    stabilizationStartedAt: active
      ? undefined
      : (incident.stabilizationStartedAt ?? anomaly.timestamp),
    anomalies,
    evidence,
    timeline,
  };
}

export class IncidentCorrelationEngine implements IncidentCorrelator {
  constructor(
    private readonly repository: IncidentRepository,
    private readonly config: IncidentCorrelationConfig,
  ) {}

  async correlate(anomaly: Anomaly): Promise<IncidentChange | undefined> {
    const prior = await this.repository.findByAnomalyId(anomaly.anomalyId);
    if (prior) {
      const updated = await this.repository.updateIncident(
        rebuild(prior, anomaly),
      );
      return { type: 'UPDATED', incident: updated };
    }
    if (anomaly.status === 'RESOLVED') return undefined;
    const primary = correlationResource(anomaly.affectedResource);
    const key = correlationKey(primary);
    const time = Date.parse(anomaly.timestamp);
    const candidates = (await this.repository.listActiveIncidents()).filter(
      (incident) =>
        Math.abs(time - Date.parse(incident.lastSeen)) <=
          this.config.correlationWindowMs &&
        this.matchesResource(incident, anomaly, key) &&
        related(incident, anomaly),
    );
    const existing = candidates.sort(
      (a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
    )[0];
    if (existing) {
      const updated = await this.repository.updateIncident(
        rebuild(existing, anomaly),
      );
      return { type: 'UPDATED', incident: updated };
    }
    const classification = classify([anomaly]);
    const incident: Incident = {
      id: randomUUID(),
      correlationKey: key,
      clusterId: anomaly.clusterId,
      namespace: anomaly.affectedResource.namespace,
      primaryResource: primary,
      affectedResources: [anomaly.affectedResource],
      classification,
      title: title(classification),
      summary: `${title(classification)} supported by 1 anomaly signal`,
      severity: deriveSeverity(classification, [anomaly]),
      status: 'OPEN',
      confidence: confidence(classification, [anomaly]),
      firstSeen: anomaly.firstSeen,
      lastSeen: anomaly.lastSeen,
      anomalies: [anomaly],
      evidence: anomaly.evidence.map((item) => ({
        ...item,
        anomalyId: anomaly.anomalyId,
        classification: anomaly.classification,
      })),
      timeline: [timelineEntry(anomaly)],
    };
    return {
      type: 'CREATED',
      incident: await this.repository.createIncident(incident),
    };
  }

  async advance(timestamp: string): Promise<readonly IncidentChange[]> {
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) return [];
    const changes: IncidentChange[] = [];
    for (const incident of await this.repository.listActiveIncidents()) {
      if (
        incident.stabilizationStartedAt &&
        time >=
          Date.parse(incident.stabilizationStartedAt) +
            this.config.stabilizationPeriodMs
      ) {
        const resolved = await this.repository.resolveIncident(
          incident.id,
          timestamp,
        );
        if (resolved) changes.push({ type: 'RESOLVED', incident: resolved });
      }
    }
    return changes;
  }

  private matchesResource(
    incident: Incident,
    anomaly: Anomaly,
    key: string,
  ): boolean {
    if (incident.correlationKey === key) return true;
    const anomalyNode = anomaly.affectedResource.node;
    if (!anomalyNode) return false;
    if (
      incident.classification === 'NODE_FAILURE' &&
      incident.primaryResource.node === anomalyNode
    )
      return anomaly.classification === 'POD_NOT_READY';
    return (
      anomaly.classification === 'NODE_NOT_READY' &&
      incident.anomalies.some(
        (item) =>
          item.classification === 'POD_NOT_READY' &&
          item.affectedResource.node === anomalyNode,
      )
    );
  }
}

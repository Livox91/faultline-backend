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
/**
 * Signal families.
 *
 * Statistical and deterministic anomalies share these groups on purpose: a
 * MEMORY_GROWTH_ANOMALY seen twenty minutes before an OOM_KILLED belongs to the same
 * operational story, and correlation is where that story is assembled. There is no
 * separate incident system for statistical findings.
 */
const memory = new Set<AnomalyClassification>([
  'HIGH_MEMORY_UTILIZATION',
  'OOM_KILLED',
  'MEMORY_USAGE_ANOMALY',
  'MEMORY_GROWTH_ANOMALY',
]);
const availability = new Set<AnomalyClassification>([
  'CRASH_LOOP',
  'POD_NOT_READY',
  'DEPLOYMENT_DEGRADED',
  'RESTART_RATE_ANOMALY',
]);
/** The workload is up but serving worse than it normally does. */
const applicationHealth = new Set<AnomalyClassification>([
  'ERROR_RATE_ANOMALY',
  'LATENCY_ANOMALY',
]);
const saturation = new Set<AnomalyClassification>([
  'HIGH_CPU_UTILIZATION',
  'CPU_USAGE_ANOMALY',
  'NETWORK_RX_ANOMALY',
  'NETWORK_TX_ANOMALY',
]);
const dependencyLogs = new Set<AnomalyClassification>([
  'DATABASE_CONNECTIVITY',
  'DEPENDENCY_TIMEOUT',
  'NETWORK_FAILURE',
  'STORAGE_FAILURE',
]);
const accessLogs = new Set<AnomalyClassification>([
  'AUTHENTICATION_FAILURE',
  'AUTHORIZATION_FAILURE',
  'RATE_LIMITING',
]);
const families = [
  memory,
  availability,
  applicationHealth,
  saturation,
  dependencyLogs,
  accessLogs,
];

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
  for (const family of families)
    if (
      family.has(anomaly.classification) &&
      [...classes].some((item) => family.has(item))
    )
      return true;
  // Resource pressure and application health reinforce each other: a workload starved
  // of CPU usually shows it in latency long before anything crashes.
  if (
    applicationHealth.has(anomaly.classification) &&
    [...classes].some((item) => saturation.has(item))
  )
    return true;
  if (
    saturation.has(anomaly.classification) &&
    [...classes].some((item) => applicationHealth.has(item))
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
    dependencyLogs.has(anomaly.classification) &&
    ([...classes].some((item) => applicationHealth.has(item)) ||
      classes.has('POD_NOT_READY'))
  )
    return true;
  if (
    [...classes].some((item) => dependencyLogs.has(item)) &&
    (applicationHealth.has(anomaly.classification) ||
      anomaly.classification === 'POD_NOT_READY')
  )
    return true;
  if (
    (anomaly.classification === 'CONFIGURATION_ERROR' &&
      (classes.has('CRASH_LOOP') || classes.has('POD_NOT_READY'))) ||
    ((anomaly.classification === 'CRASH_LOOP' ||
      anomaly.classification === 'POD_NOT_READY') &&
      classes.has('CONFIGURATION_ERROR'))
  )
    return true;
  if (
    (anomaly.classification === 'RESOURCE_EXHAUSTION' &&
      [...classes].some((item) => memory.has(item))) ||
    (memory.has(anomaly.classification) && classes.has('RESOURCE_EXHAUSTION'))
  )
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
  if (
    classes.has('OOM_KILLED') ||
    classes.has('HIGH_MEMORY_UTILIZATION') ||
    (classes.has('RESOURCE_EXHAUSTION') &&
      (classes.has('MEMORY_USAGE_ANOMALY') ||
        classes.has('MEMORY_GROWTH_ANOMALY')))
  )
    return 'MEMORY_EXHAUSTION';
  if (classes.has('DEPLOYMENT_DEGRADED')) return 'DEPLOYMENT_DEGRADATION';
  if ([...classes].some((item) => dependencyLogs.has(item)))
    return 'APPLICATION_DEPENDENCY_FAILURE';
  if (
    classes.has('CONFIGURATION_ERROR') ||
    classes.has('STARTUP_FAILURE') ||
    classes.has('IMAGE_PULL_FAILURE') ||
    classes.has('FAILED_MOUNT')
  )
    return 'WORKLOAD_CONFIGURATION_FAILURE';
  if (classes.has('CRASH_LOOP') || classes.has('POD_NOT_READY'))
    return 'WORKLOAD_CRASHING';
  if (classes.has('FAILED_SCHEDULING')) return 'SCHEDULING_FAILURE';
  // Checked after the deterministic failures: a crash-looping workload is crashing,
  // even though it is also, incidentally, serving errors.
  if (
    classes.has('ERROR_RATE_ANOMALY') ||
    classes.has('LATENCY_ANOMALY') ||
    classes.has('APPLICATION_EXCEPTION') ||
    [...classes].some((item) => accessLogs.has(item))
  )
    return 'APPLICATION_DEGRADATION';
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
    // A statistical memory signal that preceded the failure is corroboration: the
    // workload was already drifting away from its own normal before Kubernetes acted.
    const statistical =
      classes.has('MEMORY_GROWTH_ANOMALY') ||
      classes.has('MEMORY_USAGE_ANOMALY');
    if (highMemory && oom && restart) return 0.98;
    if (highMemory && oom) return statistical ? 0.95 : 0.9;
    if (oom) return statistical ? 0.85 : 0.8;
    if (highMemory && statistical) return 0.6;
    return 0.45;
  }
  if (classification === 'APPLICATION_DEGRADATION') {
    const errors = classes.has('ERROR_RATE_ANOMALY');
    const latency = classes.has('LATENCY_ANOMALY');
    const saturated = [...classes].some((item) => saturation.has(item));
    if (errors && latency) return saturated ? 0.9 : 0.85;
    return saturated ? 0.7 : 0.6;
  }
  if (classification === 'APPLICATION_DEPENDENCY_FAILURE') {
    const semantic = anomalies.filter((item) =>
      dependencyLogs.has(item.classification),
    );
    let value = Math.max(0.5, ...semantic.map((item) => item.confidence * 0.7));
    if (classes.has('ERROR_RATE_ANOMALY')) value += 0.12;
    if (classes.has('LATENCY_ANOMALY')) value += 0.12;
    if (classes.has('POD_NOT_READY')) value += 0.12;
    return Math.min(0.95, value);
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
  // Errors and latency degrading together is a user-visible failure even when neither
  // signal alone cleared HIGH on its own magnitude.
  if (
    classification === 'APPLICATION_DEGRADATION' &&
    anomalies.some((item) => item.classification === 'ERROR_RATE_ANOMALY') &&
    anomalies.some((item) => item.classification === 'LATENCY_ANOMALY') &&
    severityRank[severity] < severityRank.HIGH
  )
    severity = 'HIGH';
  if (
    classification === 'APPLICATION_DEPENDENCY_FAILURE' &&
    anomalies.filter(
      (item) =>
        dependencyLogs.has(item.classification) ||
        applicationHealth.has(item.classification) ||
        item.classification === 'POD_NOT_READY',
    ).length >= 3 &&
    severityRank[severity] < severityRank.HIGH
  )
    severity = 'HIGH';
  return severity;
}

function timelineEntry(anomaly: Anomaly): IncidentTimelineEntry {
  return {
    id:
      anomaly.source === 'LOG_CLASSIFIER'
        ? `${anomaly.anomalyId}:${anomaly.status}`
        : `${anomaly.anomalyId}:${anomaly.status}:${anomaly.timestamp}`,
    timestamp: anomaly.timestamp,
    type:
      anomaly.status === 'OPEN'
        ? 'ANOMALY_OPENED'
        : anomaly.status === 'ACTIVE'
          ? 'ANOMALY_ACTIVE'
          : 'ANOMALY_RESOLVED',
    anomalyId: anomaly.anomalyId,
    classification: anomaly.classification,
    source: anomaly.source,
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
      source: anomaly.source,
    };
    const samePattern =
      next.source === 'LOG_CLASSIFIER'
        ? evidence.findIndex(
            (candidate) =>
              candidate.source === 'LOG_CLASSIFIER' &&
              candidate.attributes?.patternId === next.attributes?.patternId,
          )
        : -1;
    if (samePattern >= 0) evidence[samePattern] = next;
    else if (
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
        source: anomaly.source,
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

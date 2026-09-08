import type {
  AnomalyAffectedResource,
  AnomalyEvidence,
} from '@faultline/incidents';
import type { KubernetesEvent, TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';

export function resourceFromState(
  state: ResourceState,
): AnomalyAffectedResource {
  return {
    scope: state.scope,
    clusterId: state.clusterId,
    namespace: state.namespace,
    workload: state.workload,
    workloadKind: state.workloadKind,
    workloadUid: state.workloadUid,
    pod: state.pod,
    podUid: state.podUid,
    container: state.container,
    node: state.node,
  };
}

export function resourceFromEvent(
  event: TelemetryEvent,
): AnomalyAffectedResource {
  if (event.kind !== 'kubernetes') {
    const scope = event.container
      ? 'container'
      : event.pod
        ? 'pod'
        : event.node
          ? 'node'
          : 'pod';
    return {
      scope,
      clusterId: event.clusterId,
      namespace: event.namespace,
      workload: event.workload,
      workloadKind: workloadKind(event),
      workloadUid: stringAttribute(event, 'k8s.deployment.uid'),
      pod: event.pod,
      container: event.container,
      node: event.node,
      podUid: stringAttribute(event, 'k8s.pod.uid'),
    };
  }
  const kind = event.involvedObject.kind.toLowerCase();
  const scope =
    kind === 'node' ? 'node' : kind === 'deployment' ? 'deployment' : 'pod';
  return {
    scope,
    clusterId: event.clusterId,
    namespace: event.namespace ?? event.involvedObject.namespace,
    workload:
      event.workload ??
      (scope === 'deployment' ? event.involvedObject.name : undefined),
    workloadKind:
      workloadKind(event) ??
      (scope === 'deployment' ? 'Deployment' : undefined),
    workloadUid: stringAttribute(event, 'k8s.deployment.uid'),
    pod: event.pod ?? (kind === 'pod' ? event.involvedObject.name : undefined),
    podUid: kind === 'pod' ? event.involvedObject.uid : undefined,
    container: event.container,
    node:
      event.node ?? (kind === 'node' ? event.involvedObject.name : undefined),
  };
}

export function resourceKey(resource: AnomalyAffectedResource): string {
  const identity =
    resource.scope === 'node'
      ? resource.node
      : resource.scope === 'deployment'
        ? resource.workload
        : (resource.podUid ?? resource.pod);
  return JSON.stringify([
    resource.clusterId,
    resource.scope,
    resource.namespace ?? '',
    identity ?? '',
    resource.scope === 'container' ? (resource.container ?? '') : '',
  ]);
}

export function anomalyKey(
  classification: string,
  resource: AnomalyAffectedResource,
): string {
  return classification + ':' + resourceKey(resource);
}

export function sameWorkload(
  a: AnomalyAffectedResource,
  event: TelemetryEvent,
): boolean {
  if (a.clusterId !== event.clusterId || a.namespace !== event.namespace)
    return false;
  if (a.podUid && stringAttribute(event, 'k8s.pod.uid'))
    return a.podUid === stringAttribute(event, 'k8s.pod.uid');
  if (a.pod && event.pod) return a.pod === event.pod;
  if (a.workload && event.workload) return a.workload === event.workload;
  if (a.node && event.node) return a.node === event.node;
  return false;
}

export function telemetryEvidence(
  event: TelemetryEvent,
  summary: string,
): AnomalyEvidence {
  return {
    type: 'telemetry',
    summary,
    timestamp: event.timestamp,
    eventId: event.id,
  };
}

export function stateEvidence(
  state: ResourceState,
  summary: string,
  attributes?: Record<string, string | number | boolean | null>,
): AnomalyEvidence {
  return {
    type: 'resource-state',
    summary,
    timestamp: state.updatedAt,
    attributes,
  };
}

export function calculationEvidence(
  state: ResourceState,
  summary: string,
  attributes: Record<string, number>,
): AnomalyEvidence {
  return {
    type: 'calculation',
    summary,
    timestamp: state.updatedAt,
    attributes,
  };
}

export function isReason(
  event: TelemetryEvent,
  reasons: readonly string[],
): event is KubernetesEvent {
  return event.kind === 'kubernetes' && reasons.includes(event.reason);
}

export function stringAttribute(
  event: TelemetryEvent,
  name: string,
): string | undefined {
  const value = event.attributes[name];
  return typeof value === 'string' ? value : undefined;
}

function workloadKind(event: TelemetryEvent): string | undefined {
  const explicit = stringAttribute(event, 'k8s.workload.kind');
  if (explicit) return explicit;
  if (
    event.workload &&
    stringAttribute(event, 'k8s.deployment.name') === event.workload
  )
    return 'Deployment';
  if (
    event.workload &&
    stringAttribute(event, 'k8s.replicaset.name') === event.workload
  )
    return 'ReplicaSet';
  return undefined;
}

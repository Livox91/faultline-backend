import type { AnomalyAffectedResource } from '@faultline/incidents';

const replicaSetSuffix = /^(.*)-[a-f0-9]{5,10}$/i;
const podSuffix = /^(.*)-[a-f0-9]{5,10}-[a-z0-9]{5}$/i;

function deploymentName(resource: AnomalyAffectedResource): string | undefined {
  if (resource.scope === 'deployment') return resource.workload;
  if (resource.workload) {
    if (resource.workloadKind?.toLowerCase() === 'deployment')
      return resource.workload;
    if (
      resource.workloadKind?.toLowerCase() === 'replicaset' ||
      resource.pod?.startsWith(resource.workload + '-')
    )
      return replicaSetSuffix.exec(resource.workload)?.[1] ?? resource.workload;
    return resource.workload;
  }
  return resource.pod ? podSuffix.exec(resource.pod)?.[1] : undefined;
}

/** Resolve Pod -> ReplicaSet -> Deployment from enriched ownership, with a pod-name fallback. */
export function primaryResourceFor(
  resource: AnomalyAffectedResource,
): AnomalyAffectedResource {
  if (resource.scope === 'node')
    return {
      scope: 'node',
      clusterId: resource.clusterId,
      node: resource.node,
    };
  const workload = deploymentName(resource);
  if (workload)
    return {
      scope: 'deployment',
      clusterId: resource.clusterId,
      namespace: resource.namespace,
      workload,
      workloadKind: 'Deployment',
      workloadUid: resource.workloadUid,
    };
  return {
    scope: 'pod',
    clusterId: resource.clusterId,
    namespace: resource.namespace,
    pod: resource.pod,
    podUid: resource.podUid,
    node: resource.node,
  };
}

export const correlationResource = primaryResourceFor;

export function correlationKey(resource: AnomalyAffectedResource): string {
  const primary = primaryResourceFor(resource);
  const identity =
    primary.scope === 'node'
      ? primary.node
      : primary.scope === 'deployment'
        ? (primary.workloadUid ?? primary.workload)
        : (primary.podUid ?? primary.pod);
  return JSON.stringify([
    primary.clusterId,
    primary.namespace ?? '',
    primary.scope,
    identity ?? '',
  ]);
}

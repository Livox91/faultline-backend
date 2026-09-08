/** Reference to any Kubernetes API object, including custom resources. */
export interface KubernetesObjectReference {
  clusterId: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
}

/** Cluster is a logical platform identity, not a Kubernetes API object. */
export interface Cluster {
  kind: 'Cluster';
  clusterId: string;
  name: string;
}

export interface Namespace extends KubernetesObjectReference {
  apiVersion: 'v1';
  kind: 'Namespace';
  namespace?: never;
}

export interface Deployment extends KubernetesObjectReference {
  apiVersion: 'apps/v1';
  kind: 'Deployment';
  namespace: string;
}

export interface Pod extends KubernetesObjectReference {
  apiVersion: 'v1';
  kind: 'Pod';
  namespace: string;
}

/** A container is identified within its pod, not as a standalone API object. */
export interface Container {
  kind: 'Container';
  clusterId: string;
  namespace: string;
  pod: string;
  podUid?: string;
  name: string;
}

export interface Node extends KubernetesObjectReference {
  apiVersion: 'v1';
  kind: 'Node';
  namespace?: never;
}

export type KubernetesResourceIdentity =
  Cluster | Namespace | Deployment | Pod | Container | Node;

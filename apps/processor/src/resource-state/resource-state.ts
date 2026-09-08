import type { MetricEvent, TelemetryEvent } from '@faultline/telemetry';

export const RESOURCE_STATE = Symbol('faultline.resource-state');

export interface ResourceIdentity {
  clusterId: string;
  scope: 'container' | 'pod' | 'deployment' | 'node';
  namespace?: string;
  pod?: string;
  podUid?: string;
  container?: string;
  workload?: string;
  workloadKind?: string;
  workloadUid?: string;
  node?: string;
}

export interface ResourceState extends ResourceIdentity {
  /** CPU values are cores; memory values are bytes. Missing values remain absent. */
  cpuUsage?: number;
  memoryUsage?: number;
  cpuLimit?: number;
  memoryLimit?: number;
  cpuRequest?: number;
  memoryRequest?: number;
  ready?: boolean | null;
  podPhase?: number;
  containerState?: string;
  containerStateReason?: string | null;
  terminationReason?: string | null;
  lastTerminationReason?: string | null;
  restartCount?: number;
  previousRestartCount?: number;
  restartDelta?: number;
  restartCounterReset?: boolean;
  desiredReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  nodeConditions?: Record<string, boolean | null>;
  cpuUtilizationPercent?: number;
  memoryUtilizationPercent?: number;
  /** Event-time of newest live field. fieldTimestamps exposes independently sampled values. */
  updatedAt: string;
  fieldTimestamps: Record<string, string>;
}

export interface ResourceStateStore {
  update(event: MetricEvent): ResourceState | undefined;
  get(identity: ResourceIdentity): ResourceState | undefined;
  findForTelemetry(event: TelemetryEvent): ResourceState | undefined;
  sweep(): void;
}

import type { KubernetesResourceIdentity } from '@faultline/kubernetes';

export interface IncidentReference {
  id: string;
  clusterId: string;
}

export type IncidentSeverity = 'unknown' | 'info' | 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'investigating' | 'resolved';

export interface EvidenceReference {
  /** ID of the supporting telemetry event, not the raw payload itself. */
  eventId: string;
}

export interface Incident extends IncidentReference {
  /** Must belong to clusterId; enforce this when incident writes are implemented. */
  affectedResource: KubernetesResourceIdentity;
  /** Taxonomy is deferred; null means not yet classified. */
  classification: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  /** Range 0–1; null means no confidence estimate is available. */
  confidence: number | null;
  /** ISO 8601 timestamps; lastSeen must be at or after firstSeen. */
  firstSeen: string;
  lastSeen: string;
  evidenceReferences: readonly EvidenceReference[];
}

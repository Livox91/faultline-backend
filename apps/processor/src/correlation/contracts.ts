import type { Anomaly, Incident } from '@faultline/incidents';

export const INCIDENT_CORRELATOR = Symbol('faultline.incident-correlator');

export type IncidentChangeType = 'CREATED' | 'UPDATED' | 'RESOLVED';

export interface IncidentChange {
  type: IncidentChangeType;
  incident: Incident;
}

export interface IncidentCorrelator {
  correlate(anomaly: Anomaly): Promise<IncidentChange | undefined>;
  /** Advance stabilization using event time, even when no anomaly was emitted. */
  advance(timestamp: string): Promise<readonly IncidentChange[]>;
}

import { randomUUID } from 'node:crypto';
import type {
  AnomalyClassification,
  AnomalySeverity,
  AnomalySource,
  AnomalyStatus,
  Incident,
  IncidentRepository,
  IncidentTimelineEntry,
} from '@faultline/incidents';
import type {
  IncidentAcknowledgementRepository,
} from '@faultline/notifications';
import { sanitizeSensitiveContent } from '@faultline/platform';

export * from './analytics';
export * from './system-summary';
export * from './exporter';
export * from './pdf-exporter';

/** A code-analysis finding as exposed by a future normalized analysis subsystem. */
export interface IncidentCodeAnalysisFinding {
  id: string;
  severity: AnomalySeverity;
  title: string;
  description?: string;
  location?: string;
}

export interface IncidentCodeAnalysisProvider {
  listForIncident(incident: Incident): Promise<readonly IncidentCodeAnalysisFinding[]>;
}

/** A remediation record as exposed by a future normalized remediation subsystem. */
export interface IncidentRemediationRecord {
  id: string;
  title: string;
  description?: string;
  occurredAt?: string;
}

export interface IncidentRemediationData {
  suggested: readonly IncidentRemediationRecord[];
  executed: readonly IncidentRemediationRecord[];
}

export interface IncidentRemediationProvider {
  getForIncident(incident: Incident): Promise<IncidentRemediationData | undefined>;
}

/** Framework-independent service health relevant to the incident window. */
export interface IncidentServiceHealth {
  service: string;
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  observedAt?: string;
  summary?: string;
}

export interface IncidentHealthProvider {
  listForIncident(incident: Incident): Promise<readonly IncidentServiceHealth[]>;
}

export interface IncidentAnomalyStatistics {
  total: number;
  byClassification: Readonly<Partial<Record<AnomalyClassification, number>>>;
  bySource: Readonly<Partial<Record<AnomalySource, number>>>;
  bySeverity: Readonly<Partial<Record<AnomalySeverity, number>>>;
  byStatus: Readonly<Partial<Record<AnomalyStatus, number>>>;
}

export interface IncidentTechnicalReport {
  reportId: string;
  generatedAt: string;
  incident: Pick<
    Incident,
    'id' | 'title' | 'severity' | 'status' | 'classification' | 'clusterId' | 'namespace'
  > & {
    detectedAt: string;
    acknowledgedAt: string | null;
    resolvedAt: string | null;
    durationMs: number;
    affectedServices: readonly string[];
  };
  summary: {
    description: string;
    suspectedCause: string | null;
    rootCause: string | null;
  };
  anomalies: IncidentAnomalyStatistics;
  codeAnalysis: {
    totalFindings: number;
    criticalFindings: number;
    findings: readonly IncidentCodeAnalysisFinding[];
  };
  remediation: IncidentRemediationData;
  health: { services: readonly IncidentServiceHealth[] };
  timeline: readonly IncidentTimelineEntry[];
}

export interface IncidentReportBuilderOptions {
  codeAnalysis?: IncidentCodeAnalysisProvider;
  remediation?: IncidentRemediationProvider;
  health?: IncidentHealthProvider;
  now?: () => Date;
  createReportId?: () => string;
}

/** Aggregates normalized incident data without depending on HTTP or persistence adapters. */
export class IncidentReportBuilder {
  private readonly now: () => Date;
  private readonly createReportId: () => string;

  constructor(
    private readonly incidents: IncidentRepository,
    private readonly acknowledgements?: IncidentAcknowledgementRepository,
    private readonly options: IncidentReportBuilderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createReportId = options.createReportId ?? randomUUID;
  }

  async generateIncidentReport(
    incidentId: string,
  ): Promise<IncidentTechnicalReport | undefined> {
    const incident = await this.incidents.getIncident(incidentId);
    if (!incident) return undefined;

    const generatedAt = this.now().toISOString();
    const [acknowledgement, findings, remediation, health] = await Promise.all([
      optional(() => this.acknowledgements?.get(incident.id), undefined),
      optional(() => this.options.codeAnalysis?.listForIncident(incident), []),
      optional(() => this.options.remediation?.getForIncident(incident), undefined),
      optional(() => this.options.health?.listForIncident(incident), []),
    ]);

    const report: IncidentTechnicalReport = {
      reportId: this.createReportId(),
      generatedAt,
      incident: {
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        classification: incident.classification,
        clusterId: incident.clusterId,
        ...(incident.namespace ? { namespace: incident.namespace } : {}),
        detectedAt: incident.firstSeen,
        acknowledgedAt: acknowledgement?.acknowledgedAt ?? null,
        resolvedAt: incident.resolvedAt ?? null,
        durationMs: durationMs(incident.firstSeen, incident.resolvedAt ?? generatedAt),
        affectedServices: affectedServices(incident),
      },
      summary: {
        description: incident.summary,
        suspectedCause: null,
        rootCause: incident.confirmedRootCause ?? null,
      },
      anomalies: anomalyStatistics(incident),
      codeAnalysis: {
        totalFindings: findings.length,
        criticalFindings: findings.filter((finding) => finding.severity === 'CRITICAL').length,
        findings,
      },
      remediation: remediation ?? { suggested: [], executed: [] },
      health: { services: health },
      timeline: [...incident.timeline].sort(
        (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
      ),
    };
    return sanitizeSensitiveContent(report) as IncidentTechnicalReport;
  }
}

async function optional<T>(load: () => Promise<T> | undefined, fallback: T): Promise<T> {
  try {
    return (await load()) ?? fallback;
  } catch {
    return fallback;
  }
}

function durationMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function affectedServices(incident: Incident): readonly string[] {
  const values = [
    incident.logicalService,
    ...incident.affectedResources.map((resource) => resource.workload),
  ].filter((value): value is string => !!value);
  return [...new Set(values)].sort();
}

function anomalyStatistics(incident: Incident): IncidentAnomalyStatistics {
  return {
    total: incident.anomalies.length,
    byClassification: countBy(incident.anomalies, (value) => value.classification),
    bySource: countBy(incident.anomalies, (value) => value.source),
    bySeverity: countBy(incident.anomalies, (value) => value.severity),
    byStatus: countBy(incident.anomalies, (value) => value.status),
  };
}

function countBy<T, K extends string>(
  values: readonly T[],
  key: (value: T) => K,
): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const value of values) {
    const name = key(value);
    result[name] = (result[name] ?? 0) + 1;
  }
  return result;
}

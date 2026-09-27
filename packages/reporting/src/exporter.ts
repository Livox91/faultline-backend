import {
  REDACTED_VALUE,
  sanitizeSensitiveContent,
} from '@faultline/platform';

export interface ExportResult {
  contentType: string;
  content: string | Buffer;
  filename?: string;
}

export interface ReportExporter<T = unknown> {
  export(report: T): Promise<ExportResult>;
}

export const JSON_REPORT_EXPORTER = Symbol('faultline.json-report-exporter');
export const CSV_REPORT_EXPORTER = Symbol('faultline.csv-report-exporter');
export const REDACTED_REPORT_VALUE = REDACTED_VALUE;

/** Serializes only the supplied normalized report, after JSON-safe redaction. */
export class JsonReportExporter<T = unknown> implements ReportExporter<T> {
  async export(report: T): Promise<ExportResult> {
    return {
      contentType: 'application/json',
      content: JSON.stringify(sanitizeReportContent(report)),
    };
  }
}

import type { IncidentTechnicalReport } from './index';

const incidentCsvColumns = [
  'incidentId',
  'title',
  'description',
  'severity',
  'status',
  'affectedServices',
  'detectedAt',
  'acknowledgedAt',
  'resolvedAt',
  'resolutionTimeMs',
] as const;

/** One incident technical report becomes one stable, spreadsheet-safe UTF-8 row. */
export class CsvReportExporter
  implements ReportExporter<IncidentTechnicalReport>
{
  async export(report: IncidentTechnicalReport): Promise<ExportResult> {
    const sanitized = sanitizeReportContent(report) as IncidentTechnicalReport;
    const row: Record<(typeof incidentCsvColumns)[number], CsvValue> = {
      incidentId: sanitized.incident.id,
      title: sanitized.incident.title,
      description: sanitized.summary.description,
      severity: sanitized.incident.severity,
      status: sanitized.incident.status,
      affectedServices: sanitized.incident.affectedServices.join(';'),
      detectedAt: sanitized.incident.detectedAt,
      acknowledgedAt: sanitized.incident.acknowledgedAt,
      resolvedAt: sanitized.incident.resolvedAt,
      resolutionTimeMs: sanitized.incident.resolvedAt
        ? sanitized.incident.durationMs
        : null,
    };
    return {
      contentType: 'text/csv; charset=utf-8',
      content: [
        incidentCsvColumns.join(','),
        incidentCsvColumns.map((column) => escapeCsv(row[column])).join(','),
      ].join('\r\n'),
    };
  }
}

type CsvValue = string | number | boolean | null | undefined | Date;

function escapeCsv(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Reports contain no raw database objects; this final boundary applies Faultline's
 * shared redaction and normalizes Date/bigint values before serialization.
 */
export function sanitizeReportContent(value: unknown): unknown {
  return sanitizeSensitiveContent(value);
}

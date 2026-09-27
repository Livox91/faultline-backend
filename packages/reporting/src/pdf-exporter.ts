import PDFDocument from 'pdfkit';
import type { IncidentTechnicalReport } from './index';
import {
  sanitizeReportContent,
  type ExportResult,
  type ReportExporter,
} from './exporter';

export const PDF_REPORT_EXPORTER = Symbol('faultline.pdf-report-exporter');

/** A deliberately small, text-first incident PDF presentation. */
export class PdfReportExporter
  implements ReportExporter<IncidentTechnicalReport>
{
  async export(report: IncidentTechnicalReport): Promise<ExportResult> {
    const value = sanitizeReportContent(report) as IncidentTechnicalReport;
    const document = new PDFDocument({
      size: 'A4',
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
      info: {
        Title: `Faultline Incident Report - ${value.incident.id}`,
        Author: 'Faultline',
        CreationDate: new Date(value.generatedAt),
      },
    });
    const content = collect(document);

    title(document, 'FAULTLINE INCIDENT REPORT');
    field(document, 'Report generated', value.generatedAt);
    field(document, 'Incident ID', value.incident.id);
    field(document, 'Incident title', value.incident.title);
    field(document, 'Severity', value.incident.severity);
    field(document, 'Status', value.incident.status);
    field(document, 'Detected at', value.incident.detectedAt);
    field(document, 'Acknowledged at', value.incident.acknowledgedAt);
    field(document, 'Resolved at', value.incident.resolvedAt);
    field(document, 'Duration', formatDuration(value.incident.durationMs));
    field(
      document,
      'Affected services',
      value.incident.affectedServices.length
        ? value.incident.affectedServices.join(', ')
        : null,
    );

    section(document, '1. Incident Summary');
    paragraph(document, value.summary.description || 'No summary available.');
    field(document, 'Suspected cause', value.summary.suspectedCause);
    field(document, 'Root cause', value.summary.rootCause);

    section(document, '2. Key Metrics');
    field(document, 'Incident classification', value.incident.classification);
    field(document, 'Total anomalies', value.anomalies.total);
    field(document, 'Code findings', value.codeAnalysis.totalFindings);
    field(document, 'Critical code findings', value.codeAnalysis.criticalFindings);

    section(document, '3. Anomaly Statistics');
    statisticGroup(document, 'By classification', value.anomalies.byClassification);
    statisticGroup(document, 'By source', value.anomalies.bySource);
    statisticGroup(document, 'By severity', value.anomalies.bySeverity);
    statisticGroup(document, 'By status', value.anomalies.byStatus);

    section(document, '4. Code Analysis Findings');
    if (!value.codeAnalysis.findings.length)
      paragraph(document, 'No code analysis findings available.');
    else
      for (const finding of value.codeAnalysis.findings)
        bullet(
          document,
          `[${finding.severity}] ${finding.title}${finding.description ? ` - ${finding.description}` : ''}${finding.location ? ` (${finding.location})` : ''}`,
        );

    section(document, '5. Remediation Summary');
    recordGroup(document, 'Suggested', value.remediation.suggested);
    recordGroup(document, 'Executed', value.remediation.executed);

    section(document, '6. Service Health');
    if (!value.health.services.length)
      paragraph(document, 'No service health data available.');
    else
      for (const health of value.health.services)
        bullet(
          document,
          `${health.service}: ${health.status}${health.summary ? ` - ${health.summary}` : ''}${health.observedAt ? ` (${health.observedAt})` : ''}`,
        );

    section(document, '7. Incident Timeline');
    if (!value.timeline.length)
      paragraph(document, 'No timeline entries available.');
    else
      for (const entry of value.timeline)
        bullet(
          document,
          `${entry.timestamp} | ${entry.type} | ${entry.severity} | ${entry.summary}`,
        );

    document.end();
    return {
      contentType: 'application/pdf',
      filename: `faultline-incident-${safeFilenamePart(value.incident.id)}.pdf`,
      content: await content,
    };
  }
}

function collect(document: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer | Uint8Array) =>
      chunks.push(Buffer.from(chunk)),
    );
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
}

function title(document: PDFKit.PDFDocument, text: string): void {
  document.font('Helvetica-Bold').fontSize(18).text(text, { align: 'center' });
  document.moveDown(1);
}

function section(document: PDFKit.PDFDocument, text: string): void {
  document.moveDown(0.8);
  document.font('Helvetica-Bold').fontSize(13).text(text);
  document.moveDown(0.35);
}

function paragraph(document: PDFKit.PDFDocument, text: string): void {
  document.font('Helvetica').fontSize(10).text(text, { lineGap: 2 });
  document.moveDown(0.35);
}

function field(
  document: PDFKit.PDFDocument,
  label: string,
  value: string | number | null | undefined,
): void {
  document.font('Helvetica-Bold').fontSize(10).text(`${label}: `, {
    continued: true,
  });
  document
    .font('Helvetica')
    .text(value === null || value === undefined || value === '' ? 'Not available' : String(value));
}

function bullet(document: PDFKit.PDFDocument, text: string): void {
  document.font('Helvetica').fontSize(10).text(`• ${text}`, {
    indent: 12,
    lineGap: 2,
  });
  document.moveDown(0.2);
}

function statisticGroup(
  document: PDFKit.PDFDocument,
  label: string,
  values: Readonly<Record<string, number | undefined>>,
): void {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  );
  field(
    document,
    label,
    entries.length
      ? entries.map(([name, count]) => `${name}: ${count}`).join(', ')
      : null,
  );
}

function recordGroup(
  document: PDFKit.PDFDocument,
  label: string,
  records: IncidentTechnicalReport['remediation']['suggested'],
): void {
  document.font('Helvetica-Bold').fontSize(10).text(label);
  if (!records.length) paragraph(document, 'None recorded.');
  else
    for (const record of records)
      bullet(
        document,
        `${record.title}${record.description ? ` - ${record.description}` : ''}${record.occurredAt ? ` (${record.occurredAt})` : ''}`,
      );
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${durationMs} ms (${hours}h ${minutes}m ${remainder}s)`;
}

function safeFilenamePart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '-').slice(0, 100) || 'report';
}

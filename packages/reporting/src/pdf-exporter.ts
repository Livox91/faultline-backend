import PDFDocument from 'pdfkit';
import type {
  IncidentCodeAnalysisFinding,
  IncidentRemediationRecord,
  IncidentServiceHealth,
  IncidentTechnicalReport,
} from './index';
import {
  sanitizeReportContent,
  type ExportResult,
  type ReportExporter,
} from './exporter';

export const PDF_REPORT_EXPORTER = Symbol('faultline.pdf-report-exporter');

const COLOR = {
  navy: '#123B70', blue: '#3478C8', lightBlue: '#F3F7FC', white: '#FFFFFF',
  text: '#1E293B', secondary: '#64748B', border: '#DCE6F2', critical: '#B42318',
  criticalBackground: '#FEE4E2', warning: '#B54708', warningBackground: '#FEF0C7',
  resolved: '#067647', resolvedBackground: '#D1FADF', neutralBackground: '#E8EEF6',
} as const;

const PAGE_MARGIN = { top: 68, right: 48, bottom: 58, left: 48 };
const BODY_FONT = 'Helvetica';
const BOLD_FONT = 'Helvetica-Bold';

/** Production PDF presentation for the normalized incident report contract. */
export class PdfReportExporter implements ReportExporter<IncidentTechnicalReport> {
  async export(report: IncidentTechnicalReport): Promise<ExportResult> {
    const value = sanitizeReportContent(report) as IncidentTechnicalReport;
    const document = new PDFDocument({
      size: 'A4', margins: PAGE_MARGIN, bufferPages: true,
      info: {
        Title: `Faultline Incident Report - ${value.incident.id}`,
        Author: 'Faultline Observability', Subject: value.incident.title,
        CreationDate: new Date(value.generatedAt),
      },
    });
    const content = collect(document);
    runningPageChrome(document);
    document.on('pageAdded', () => runningPageChrome(document));

    reportHeader(document, value);
    executiveSummary(document, value);
    keyMetrics(document, value);
    anomalyAnalysis(document, value);
    resourceSnapshots(document, value);
    serviceHealth(document, value.health.services);
    rootCauseAndCodeAnalysis(document, value);
    remediationSummary(document, value);
    incidentTimeline(document, value);
    technicalAppendix(document, value);
    pageNumbers(document, value.incident.id);

    document.end();
    return {
      contentType: 'application/pdf',
      filename: `faultline-incident-${safeFilenamePart(value.incident.id)}.pdf`,
      content: await content,
    };
  }
}

function reportHeader(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  const { incident } = report;
  document.rect(0, 0, document.page.width, 178).fill(COLOR.navy);
  document.fillColor(COLOR.white).font(BOLD_FONT).fontSize(10)
    .text('FAULTLINE  /  APPLICATION OBSERVABILITY', PAGE_MARGIN.left, 28, { characterSpacing: 0.7 });
  document.font(BOLD_FONT).fontSize(26)
    .text('Incident Report', PAGE_MARGIN.left, 53, { width: contentWidth(document) });
  document.font(BODY_FONT).fontSize(14).fillColor('#DCE9F8')
    .text(incident.title, PAGE_MARGIN.left, 91, {
      width: contentWidth(document), height: 38, ellipsis: true,
    });
  badge(document, incident.severity, PAGE_MARGIN.left, 137);
  badge(document, incident.status, PAGE_MARGIN.left + 92, 137);
  document.y = 198;
  keyValueGrid(document, [
    ['Incident ID', incident.id],
    ['Generated', formatTimestamp(report.generatedAt)],
    ['Detected', formatTimestamp(incident.detectedAt)],
    ['Affected services', incident.affectedServices.length ? incident.affectedServices.join(', ') : 'Not available'],
  ]);
}

function executiveSummary(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '1. Executive Summary');
  callout(document, report.summary.description || 'No incident summary was provided.');
  const incident = report.incident;
  dataTable(document, [
    { label: 'Item', fraction: 0.28 },
    { label: 'Confirmed report data', fraction: 0.72 },
  ], [
    ['What happened', compactRepeatedNarrative(report.summary.description || 'Not available')],
    ['Affected services', incident.affectedServices.length ? incident.affectedServices.join(', ') : 'Not available'],
    ['Current status', incident.status],
    ['Duration', formatDuration(incident.durationMs)],
    ['Main detected symptom', incident.classification],
    ['Confirmed root cause', report.summary.rootCause ?? 'Root cause not identified.'],
  ]);
  paragraph(document,
    'Facts above come from the normalized incident record. Correlated signals are evidence, not proof of causation.',
    { color: COLOR.secondary, fontSize: 8.5 });
}

function keyMetrics(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '2. Key Metrics');
  const snapshot = report.resourceSnapshots?.[0];
  const cards: MetricCard[] = [
    { label: 'Total anomalies', value: String(report.anomalies.total) },
    { label: 'Affected services', value: String(report.incident.affectedServices.length) },
    { label: 'Critical findings', value: String(report.codeAnalysis.criticalFindings) },
    { label: 'Code findings', value: String(report.codeAnalysis.totalFindings) },
    { label: report.incident.status === 'RESOLVED' ? 'Duration' : 'Elapsed', value: formatDurationCompact(report.incident.durationMs) },
    {
      label: 'CPU at detection',
      value: snapshot?.cpuUsageCores === undefined ? 'Not available' : `${formatNumber(snapshot.cpuUsageCores)} cores`,
      detail: percent(snapshot?.cpuUtilizationPercent) ?? undefined,
    },
    {
      label: 'Memory at detection', value: bytes(snapshot?.memoryUsageBytes) ?? 'Not available',
      detail: percent(snapshot?.memoryUtilizationPercent) ?? undefined,
    },
  ];
  metricCards(document, cards);
  if ((report.resourceSnapshots?.length ?? 0) > 1)
    paragraph(document,
      `CPU and memory cards show the first of ${report.resourceSnapshots.length} recorded resource snapshots. All snapshots are listed below.`,
      { color: COLOR.secondary, fontSize: 8.5 });
}

function anomalyAnalysis(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '3. Anomaly Analysis');
  const groups: ReadonlyArray<readonly [string, Readonly<Record<string, number | undefined>>]> = [
    ['By classification', report.anomalies.byClassification],
    ['By source', report.anomalies.bySource],
    ['By severity', report.anomalies.bySeverity],
    ['By status', report.anomalies.byStatus],
  ];
  for (const [label, values] of groups) {
    categoricalChart(document, label, values);
    const suppliedTotal = Object.values(values).reduce<number>((sum, count) => sum + (count ?? 0), 0);
    if (Object.keys(values).length && suppliedTotal !== report.anomalies.total)
      callout(document,
        `${label} totals ${suppliedTotal}, while the report records ${report.anomalies.total} total anomalies. Values are preserved as supplied.`,
        'warning');
  }
}

function resourceSnapshots(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '4. CPU and Memory at Incident Detection');
  const snapshots = report.resourceSnapshots ?? [];
  if (!snapshots.length) {
    unavailable(document, 'No CPU or memory snapshot was recorded for this incident.');
    return;
  }
  dataTable(document, [
    { label: 'Resource / observed', fraction: 0.28 },
    { label: 'CPU', fraction: 0.24 },
    { label: 'Memory', fraction: 0.28 },
    { label: 'Limits / requests', fraction: 0.2 },
  ], snapshots.map((snapshot) => [
    `${resourceName(snapshot.resource)}\n${snapshot.observedAt}`,
    [valueOrUnavailable(snapshot.cpuUsageCores, ' cores'), percent(snapshot.cpuUtilizationPercent)].filter(Boolean).join(' / '),
    [bytes(snapshot.memoryUsageBytes), percent(snapshot.memoryUtilizationPercent)].filter(Boolean).join(' / ') || 'Not available',
    `CPU: ${valueOrUnavailable(snapshot.cpuRequestCores, ' req')}, ${valueOrUnavailable(snapshot.cpuLimitCores, ' limit')}\nMemory: ${bytes(snapshot.memoryRequestBytes) ?? 'Not available'} req, ${bytes(snapshot.memoryLimitBytes) ?? 'Not available'} limit`,
  ]));
}

function serviceHealth(document: PDFKit.PDFDocument, services: readonly IncidentServiceHealth[]): void {
  sectionHeading(document, '5. Service Health');
  if (!services.length) {
    unavailable(document, 'Service health data was not provided for this incident.');
    return;
  }
  dataTable(document, [
    { label: 'Service', fraction: 0.24 }, { label: 'Status', fraction: 0.18 },
    { label: 'Observed', fraction: 0.24 }, { label: 'Health details', fraction: 0.34 },
  ], services.map((health) => [
    health.service, health.status, health.observedAt ?? 'Not available', health.summary ?? 'Not provided',
  ]));
  paragraph(document,
    'Replica counts, restart counts, deployment checks, and health-check results are not part of the supplied health record unless stated in Health details.',
    { color: COLOR.secondary, fontSize: 8.5 });
}

function rootCauseAndCodeAnalysis(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '6. Root-Cause and Code Analysis');
  subheading(document, 'Confirmed root cause');
  callout(document, report.summary.rootCause ?? 'Root cause not identified.', report.summary.rootCause ? 'fact' : 'neutral');
  subheading(document, 'Suspected cause');
  paragraph(document, report.summary.suspectedCause ?? 'Not available.');
  subheading(document, 'Supporting evidence');
  paragraph(document, report.timeline.length
    ? `${report.timeline.length} recorded timeline signal(s) are retained in the timeline and technical appendix.`
    : 'No supporting timeline signals were provided.');
  subheading(document, 'Code analysis findings');
  if (!report.codeAnalysis.findings.length) {
    unavailable(document, 'No code analysis findings were reported.');
  } else {
    dataTable(document, [
      { label: 'Severity', fraction: 0.16 }, { label: 'Finding', fraction: 0.34 },
      { label: 'Description', fraction: 0.34 }, { label: 'Location', fraction: 0.16 },
    ], report.codeAnalysis.findings.map(findingRow));
  }
  subheading(document, 'Unknown or unavailable information');
  paragraph(document, [
    !report.summary.rootCause ? 'Confirmed root cause' : null,
    !report.summary.suspectedCause ? 'Suspected cause' : null,
    !report.codeAnalysis.findings.length ? 'Code analysis findings' : null,
  ].filter(Boolean).join(', ') || 'None identified in the supplied report data.');
}

function remediationSummary(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '7. Remediation Summary');
  remediationTable(document, '1. Suggested actions', report.remediation.suggested);
  remediationTable(document, '2. Executed actions', report.remediation.executed);
  subheading(document, '3. Verification results');
  unavailable(document, 'Verification results were not provided.');
  subheading(document, '4. Outstanding actions');
  unavailable(document, 'Outstanding actions were not provided.');
}

function incidentTimeline(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '8. Incident Timeline');
  if (!report.timeline.length) {
    unavailable(document, 'No timeline entries were provided.');
    return;
  }
  const chronological = [...report.timeline].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  dataTable(document, [
    { label: 'Timestamp', fraction: 0.22 }, { label: 'Event type', fraction: 0.18 },
    { label: 'Severity', fraction: 0.13 }, { label: 'Description', fraction: 0.34 },
    { label: 'Status', fraction: 0.13 },
  ], chronological.map((entry) => [
    entry.timestamp, entry.type, entry.severity, entry.summary, timelineStatus(entry.type),
  ]), { fontSize: 7.6 });
}

function technicalAppendix(document: PDFKit.PDFDocument, report: IncidentTechnicalReport): void {
  sectionHeading(document, '9. Technical Appendix');
  subheading(document, 'Incident metadata');
  keyValueGrid(document, [
    ['Report ID', report.reportId], ['Incident ID', report.incident.id],
    ['Cluster', report.incident.clusterId], ['Namespace', report.incident.namespace ?? 'Not available'],
    ['Classification', report.incident.classification], ['Detected raw timestamp', report.incident.detectedAt],
    ['Acknowledged raw timestamp', report.incident.acknowledgedAt ?? 'Not available'],
    ['Resolved raw timestamp', report.incident.resolvedAt ?? 'Not available'],
  ]);
  subheading(document, 'Detailed signal evidence');
  if (!report.timeline.length) {
    unavailable(document, 'No detailed signal evidence was provided.');
    return;
  }
  dataTable(document, [
    { label: 'Raw timestamp / signal ID', fraction: 0.3 },
    { label: 'Classification / source', fraction: 0.25 },
    { label: 'Original description', fraction: 0.45 },
  ], [...report.timeline]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((entry) => [
      `${entry.timestamp}\nEvent: ${entry.id}\nAnomaly: ${entry.anomalyId}`,
      `${entry.classification}\n${entry.source}\n${entry.severity} / ${timelineStatus(entry.type)}`,
      entry.summary,
    ]), { fontSize: 7.3 });
}

interface MetricCard { label: string; value: string; detail?: string; }
interface TableColumn { label: string; fraction: number; }

function sectionHeading(document: PDFKit.PDFDocument, text: string): void {
  ensureSpace(document, 140);
  document.moveDown(0.8);
  const y = document.y;
  document.rect(PAGE_MARGIN.left, y, 4, 18).fill(COLOR.blue);
  document.fillColor(COLOR.navy).font(BOLD_FONT).fontSize(14)
    .text(text, PAGE_MARGIN.left + 12, y + 1, { width: contentWidth(document) - 12 });
  document.y = y + 28;
}

function subheading(document: PDFKit.PDFDocument, text: string): void {
  ensureSpace(document, 60);
  document.fillColor(COLOR.navy).font(BOLD_FONT).fontSize(10)
    .text(text, PAGE_MARGIN.left, document.y, { width: contentWidth(document) });
  document.moveDown(0.3);
}

function paragraph(document: PDFKit.PDFDocument, text: string,
  options: { color?: string; fontSize?: number } = {}): void {
  const fontSize = options.fontSize ?? 9;
  document.font(BODY_FONT).fontSize(fontSize);
  const height = document.heightOfString(text, { width: contentWidth(document), lineGap: 2 });
  const available = document.page.height - PAGE_MARGIN.bottom - document.y;
  if (height <= available) {
    document.fillColor(options.color ?? COLOR.text)
      .text(text, PAGE_MARGIN.left, document.y, { width: contentWidth(document), lineGap: 2 });
    document.moveDown(0.45);
    return;
  }
  if (document.y > PAGE_MARGIN.top + 4) document.addPage();
  const maximumHeight = document.page.height - PAGE_MARGIN.top - PAGE_MARGIN.bottom - 12;
  const chunks = splitTextByHeight(document, text, contentWidth(document), maximumHeight, 2);
  chunks.forEach((chunk, index) => {
    if (index) document.addPage();
    document.fillColor(options.color ?? COLOR.text).font(BODY_FONT).fontSize(fontSize)
      .text(chunk, PAGE_MARGIN.left, document.y, {
        width: contentWidth(document), height: maximumHeight, lineGap: 2,
      });
  });
  document.moveDown(0.45);
}

function callout(document: PDFKit.PDFDocument, text: string,
  kind: 'fact' | 'warning' | 'neutral' = 'fact'): void {
  const width = contentWidth(document);
  document.font(BODY_FONT).fontSize(9);
  const height = Math.max(38, document.heightOfString(text, { width: width - 24, lineGap: 2 }) + 20);
  const maximumBoxHeight = document.page.height - PAGE_MARGIN.top - PAGE_MARGIN.bottom - 24;
  if (height > maximumBoxHeight) {
    paragraph(document, text);
    return;
  }
  ensureSpace(document, height + 8);
  const y = document.y;
  const background = kind === 'warning' ? COLOR.warningBackground : kind === 'fact' ? COLOR.lightBlue : '#F8FAFC';
  const border = kind === 'warning' ? COLOR.warning : COLOR.border;
  document.roundedRect(PAGE_MARGIN.left, y, width, height, 6).fillAndStroke(background, border);
  document.fillColor(COLOR.text).font(BODY_FONT).fontSize(9)
    .text(text, PAGE_MARGIN.left + 12, y + 10, { width: width - 24, lineGap: 2 });
  document.y = y + height + 8;
}

function unavailable(document: PDFKit.PDFDocument, text: string): void { callout(document, text, 'neutral'); }

function metricCards(document: PDFKit.PDFDocument, cards: readonly MetricCard[]): void {
  const gap = 10; const columns = 3;
  const width = (contentWidth(document) - gap * (columns - 1)) / columns;
  const height = 64;
  for (let index = 0; index < cards.length; index += columns) {
    ensureSpace(document, height + gap);
    const y = document.y;
    cards.slice(index, index + columns).forEach((card, offset) => {
      const x = PAGE_MARGIN.left + offset * (width + gap);
      document.roundedRect(x, y, width, height, 6).fillAndStroke(COLOR.white, COLOR.border);
      document.fillColor(COLOR.secondary).font(BOLD_FONT).fontSize(7.5)
        .text(card.label.toUpperCase(), x + 10, y + 10, { width: width - 20 });
      document.fillColor(COLOR.navy).font(BOLD_FONT).fontSize(card.value.length > 17 ? 11 : 15)
        .text(card.value, x + 10, y + 27, { width: width - 20, ellipsis: true });
      if (card.detail)
        document.fillColor(COLOR.secondary).font(BODY_FONT).fontSize(7.5)
          .text(card.detail, x + 10, y + 49, { width: width - 20 });
    });
    document.y = y + height + gap;
  }
}

function categoricalChart(document: PDFKit.PDFDocument, label: string,
  values: Readonly<Record<string, number | undefined>>): void {
  const entries = Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined);
  subheading(document, label);
  if (!entries.length) {
    paragraph(document, 'Not available.', { color: COLOR.secondary });
    return;
  }
  const maximum = Math.max(...entries.map(([, count]) => count), 1);
  for (const [name, count] of entries) {
    ensureSpace(document, 23);
    const x = PAGE_MARGIN.left; const y = document.y; const labelWidth = 155; const countWidth = 34;
    const barWidth = contentWidth(document) - labelWidth - countWidth;
    document.fillColor(COLOR.text).font(BODY_FONT).fontSize(8)
      .text(humanize(name), x, y + 2, { width: labelWidth - 8, ellipsis: true });
    document.roundedRect(x + labelWidth, y + 3, barWidth, 9, 4).fill(COLOR.neutralBackground);
    document.roundedRect(x + labelWidth, y + 3, Math.max(3, (count / maximum) * barWidth), 9, 4).fill(COLOR.blue);
    document.fillColor(COLOR.text).font(BOLD_FONT).fontSize(8)
      .text(String(count), x + labelWidth + barWidth + 7, y + 2, { width: countWidth - 7, align: 'right' });
    document.y = y + 19;
  }
  document.x = PAGE_MARGIN.left;
  document.y += 4;
}

function dataTable(document: PDFKit.PDFDocument, columns: readonly TableColumn[],
  rows: readonly (readonly string[])[], options: { fontSize?: number } = {}): void {
  const fontSize = options.fontSize ?? 8; const x = PAGE_MARGIN.left; const width = contentWidth(document);
  const widths = columns.map((column) => width * column.fraction); const headerHeight = 27;
  document.font(BODY_FONT).fontSize(fontSize);
  const preparedRows = rows.flatMap((row) => splitTableRow(document, row, widths, fontSize));
  let cursorY = document.y;
  let rowsOnPage = 0;
  const newTablePage = () => {
    document.addPage();
    cursorY = PAGE_MARGIN.top;
    rowsOnPage = 0;
  };
  const drawHeader = () => {
    if (cursorY + headerHeight + 70 > document.page.height - PAGE_MARGIN.bottom)
      newTablePage();
    const y = cursorY;
    document.rect(x, y, width, headerHeight).fill(COLOR.navy);
    let cellX = x;
    const bottomMargin = document.page.margins.bottom;
    document.page.margins.bottom = -10_000;
    columns.forEach((column, index) => {
      document.fillColor(COLOR.white).font(BOLD_FONT).fontSize(7.5)
        .text(column.label, cellX + 6, y + 9, {
          width: widths[index]! - 12, height: headerHeight - 12, ellipsis: true,
        });
      cellX += widths[index]!;
    });
    document.page.margins.bottom = bottomMargin;
    cursorY = y + headerHeight;
    document.y = cursorY;
  };
  drawHeader();
  preparedRows.forEach((row, rowIndex) => {
    document.font(BODY_FONT).fontSize(fontSize);
    const heights = row.map((cell, index) => document.heightOfString(cell || 'Not available', {
      width: widths[index]! - 12, lineGap: 1.5,
    }));
    const rowHeight = Math.max(25, ...heights) + 12;
    // PDFKit's final line box is slightly taller than heightOfString reports for
    // narrow, heavily wrapped cells. Keep a conservative buffer so it never creates
    // an unstyled continuation page behind the table renderer's back.
    if (rowsOnPage >= 10 || cursorY + rowHeight + 20 > document.page.height - PAGE_MARGIN.bottom) {
      newTablePage();
      drawHeader();
    }
    const y = cursorY;
    document.rect(x, y, width, rowHeight)
      .fillAndStroke(rowIndex % 2 ? COLOR.lightBlue : COLOR.white, COLOR.border);
    let cellX = x;
    const bottomMargin = document.page.margins.bottom;
    document.page.margins.bottom = -10_000;
    row.forEach((cell, index) => {
      if (index) document.moveTo(cellX, y).lineTo(cellX, y + rowHeight).strokeColor(COLOR.border).stroke();
      document.fillColor(COLOR.text).font(BODY_FONT).fontSize(fontSize)
        .text(cell || 'Not available', cellX + 6, y + 7, {
          width: widths[index]! - 12, height: rowHeight - 14, lineGap: 1.5,
        });
      cellX += widths[index]!;
    });
    document.page.margins.bottom = bottomMargin;
    cursorY = y + rowHeight;
    document.y = cursorY;
    rowsOnPage += 1;
  });
  document.x = PAGE_MARGIN.left;
  document.y = cursorY + 8;
}

function splitTableRow(
  document: PDFKit.PDFDocument,
  row: readonly string[],
  widths: readonly number[],
  fontSize: number,
): readonly (readonly string[])[] {
  const maximumCellHeight = 430;
  document.font(BODY_FONT).fontSize(fontSize);
  const cells = row.map((cell, index) =>
    splitTextByHeight(document, cell || 'Not available', widths[index]! - 12, maximumCellHeight),
  );
  const parts = Math.max(...cells.map((cell) => cell.length));
  return Array.from({ length: parts }, (_, part) =>
    cells.map((cell, index) => cell[part] ?? (part > 0 && index === 0 ? 'Continued' : '')),
  );
}

function splitTextByHeight(
  document: PDFKit.PDFDocument,
  text: string,
  width: number,
  maximumHeight: number,
  lineGap = 1.5,
): readonly string[] {
  if (document.heightOfString(text, { width, lineGap }) <= maximumHeight)
    return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && document.heightOfString(candidate, { width, lineGap }) > maximumHeight) {
      result.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) result.push(current);
  return result.length ? result : [text];
}

function keyValueGrid(document: PDFKit.PDFDocument,
  fields: ReadonlyArray<readonly [string, string]>): void {
  const width = contentWidth(document); const gap = 12; const columnWidth = (width - gap) / 2;
  for (let index = 0; index < fields.length; index += 2) {
    const pair = fields.slice(index, index + 2);
    const heights = pair.map(([, value]) => {
      document.font(BODY_FONT).fontSize(8.5);
      return 18 + document.heightOfString(value, { width: columnWidth - 20, lineGap: 1 });
    });
    const height = Math.max(45, ...heights) + 6;
    ensureSpace(document, height + 8);
    const y = document.y;
    pair.forEach(([label, value], offset) => {
      const x = PAGE_MARGIN.left + offset * (columnWidth + gap);
      document.roundedRect(x, y, columnWidth, height, 5).fillAndStroke(COLOR.white, COLOR.border);
      document.fillColor(COLOR.secondary).font(BOLD_FONT).fontSize(7.3)
        .text(label.toUpperCase(), x + 10, y + 8, { width: columnWidth - 20 });
      document.fillColor(COLOR.text).font(BODY_FONT).fontSize(8.5)
        .text(value, x + 10, y + 24, { width: columnWidth - 20, lineGap: 1 });
    });
    document.y = y + height + 8;
    document.x = PAGE_MARGIN.left;
  }
}

function remediationTable(document: PDFKit.PDFDocument, label: string,
  records: readonly IncidentRemediationRecord[]): void {
  subheading(document, label);
  if (!records.length) { unavailable(document, 'None recorded.'); return; }
  dataTable(document, [
    { label: 'Action', fraction: 0.28 }, { label: 'Description', fraction: 0.5 },
    { label: 'Recorded at', fraction: 0.22 },
  ], records.map((record) => [record.title, record.description ?? 'Not provided', record.occurredAt ?? 'Not available']));
}

function findingRow(finding: IncidentCodeAnalysisFinding): readonly string[] {
  return [finding.severity, finding.title, finding.description ?? 'Not provided', finding.location ?? 'Not available'];
}

function badge(document: PDFKit.PDFDocument, value: string, x: number, y: number): void {
  const palette = statusPalette(value); const width = Math.max(72, document.widthOfString(value) + 28);
  document.roundedRect(x, y, width, 22, 11).fill(palette.background);
  document.fillColor(palette.foreground).font(BOLD_FONT).fontSize(8)
    .text(value, x, y + 7, { width, align: 'center' });
}

function runningPageChrome(document: PDFKit.PDFDocument): void {
  const cursorX = document.x;
  const cursorY = document.y;
  const bottomMargin = document.page.margins.bottom;
  document.page.margins.bottom = 0;
  const footerY = document.page.height - 35;
  document.moveTo(PAGE_MARGIN.left, footerY - 8).lineTo(document.page.width - PAGE_MARGIN.right, footerY - 8)
    .strokeColor(COLOR.border).stroke();
  document.page.margins.bottom = bottomMargin;
  document.x = cursorX;
  document.y = cursorY;
}

function pageNumbers(document: PDFKit.PDFDocument, incidentId: string): void {
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    const footerY = document.page.height - 35;
    const bottomMargin = document.page.margins.bottom;
    document.page.margins.bottom = 0;
    document.x = 0;
    document.y = footerY;
    document.fillColor(COLOR.secondary).font(BODY_FONT).fontSize(7.5)
      .text(`Faultline Incident Report  /  ${incidentId}  /  Page ${index - range.start + 1} of ${range.count}`,
        PAGE_MARGIN.left, footerY, {
          width: contentWidth(document), align: 'right', lineBreak: false,
        });
    if (index > range.start) {
      document.moveTo(PAGE_MARGIN.left, 45).lineTo(document.page.width - PAGE_MARGIN.right, 45)
        .strokeColor(COLOR.border).stroke();
      document.x = PAGE_MARGIN.left;
      document.y = 29;
      document.fillColor(COLOR.navy).font(BOLD_FONT).fontSize(8)
        .text('FAULTLINE  /  INCIDENT REPORT', PAGE_MARGIN.left, 29, {
          width: contentWidth(document), lineBreak: false,
        });
    }
    document.page.margins.bottom = bottomMargin;
  }
}

function ensureSpace(document: PDFKit.PDFDocument, height: number): void {
  if (!hasSpace(document, height)) document.addPage();
}
function hasSpace(document: PDFKit.PDFDocument, height: number): boolean {
  return document.y + height <= document.page.height - PAGE_MARGIN.bottom;
}
function contentWidth(document: PDFKit.PDFDocument): number {
  return document.page.width - PAGE_MARGIN.left - PAGE_MARGIN.right;
}

function statusPalette(value: string): { background: string; foreground: string } {
  const normalized = value.toUpperCase();
  if (normalized === 'CRITICAL') return { background: COLOR.criticalBackground, foreground: COLOR.critical };
  if (normalized === 'RESOLVED' || normalized === 'HEALTHY')
    return { background: COLOR.resolvedBackground, foreground: COLOR.resolved };
  if (['WARNING', 'HIGH', 'ACTIVE', 'OPEN'].includes(normalized))
    return { background: COLOR.warningBackground, foreground: COLOR.warning };
  return { background: COLOR.neutralBackground, foreground: COLOR.navy };
}

function timelineStatus(type: string): string {
  if (type === 'ANOMALY_OPENED') return 'OPEN';
  if (type === 'ANOMALY_ACTIVE') return 'ACTIVE';
  if (type === 'ANOMALY_RESOLVED') return 'RESOLVED';
  return 'UNKNOWN';
}

function resourceName(resource: { workload?: string; pod?: string; container?: string; node?: string }): string {
  return [resource.workload, resource.pod, resource.container, resource.node].filter(Boolean).join(' / ') || 'Unknown resource';
}
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}
function percent(value: number | undefined): string | null {
  return value === undefined ? null : `${formatNumber(value)}%`;
}
function bytes(value: number | undefined): string | null {
  if (value === undefined) return null;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let amount = value; let index = 0;
  while (Math.abs(amount) >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${formatNumber(amount)} ${units[index]}`;
}
function valueOrUnavailable(value: number | undefined, suffix: string): string {
  return value === undefined ? 'Not available' : `${formatNumber(value)}${suffix}`;
}
function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
}
function formatDuration(durationMs: number): string {
  return `${durationMs} ms (${formatDurationCompact(durationMs)})`;
}
function formatDurationCompact(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000); const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60); const remainder = seconds % 60;
  return `${hours}h ${minutes}m ${remainder}s`;
}
function compactRepeatedNarrative(value: string): string {
  if (value.length <= 700) return value;
  return `${value.slice(0, 700).trimEnd()}... Full narrative is preserved immediately above this table.`;
}
function humanize(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/^./, (character) => character.toUpperCase());
}
function collect(document: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
}
function safeFilenamePart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '-').slice(0, 100) || 'report';
}

import PDFDocument from 'pdfkit';
import { sanitizeReportContent, type ExportResult, type ReportExporter } from './exporter';
import type { SystemSummaryReport } from './system-summary';

export const SYSTEM_SUMMARY_PDF_EXPORTER = Symbol('faultline.system-summary-pdf-exporter');

const PAGE = { left: 48, right: 547, top: 54, bottom: 752 } as const;
const WIDTH = PAGE.right - PAGE.left;
const COLOR = {
  navy: '#123B70', text: '#1E293B', muted: '#64748B', border: '#DCE6F2',
  panel: '#F3F7FC', white: '#FFFFFF', stripe: '#F8FAFC',
} as const;

/** Compact, dynamically paginated management PDF for the reporting dashboard. */
export class SystemSummaryPdfExporter implements ReportExporter<SystemSummaryReport> {
  async export(report: SystemSummaryReport): Promise<ExportResult> {
    const value = sanitizeReportContent(report) as SystemSummaryReport;
    const document = new PDFDocument({
      size: 'A4', margins: { top: PAGE.top, right: 48, bottom: 56, left: PAGE.left },
      bufferPages: true,
      info: {
        Title: 'Faultline System Summary', Author: 'Faultline Observability',
        CreationDate: new Date(value.generatedAt),
      },
    });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
    });

    cover(document, value);
    section(document, 'Executive metrics');
    metricGrid(document, [
      ['Total incidents', String(value.incidents.total)],
      ['Critical', String(value.incidents.critical)],
      ['Resolved', String(value.incidents.resolved)],
      ['Open', String(value.incidents.unresolved)],
      ['MTTR', duration(value.performance.mttrMs)],
      ['MTTA', duration(value.performance.mttaMs)],
      ['Resolution rate', `${(value.performance.resolutionRate * 100).toFixed(1)}%`],
    ]);

    section(document, 'System health');
    keyValueRows(document, [
      ['Overall status', value.health.available ? value.health.overallStatus.toUpperCase() : 'UNAVAILABLE'],
      ['Healthy services', String(value.health.healthyServices)],
      ['Degraded services', String(value.health.degradedServices)],
      ['Unhealthy services', String(value.health.unhealthyServices)],
    ]);

    section(document, 'Incidents by severity');
    twoColumnTable(document, ['Severity', 'Incidents'],
      Object.entries(value.incidentsBySeverity).map(([severity, count]) => [severity, String(count)]));
    section(document, 'Top affected services');
    twoColumnTable(document, ['Service', 'Incidents'],
      value.topAffectedServices.map((item) => [item.service, String(item.incidentCount)]));
    section(document, 'Common incident categories');
    twoColumnTable(document, ['Category', 'Incidents'],
      value.commonIncidentCategories.map((item) => [item.classification.replaceAll('_', ' '), String(item.incidentCount)]));
    section(document, 'Daily incident trend');
    twoColumnTable(document, ['Date', 'Total / Critical / Resolved'],
      value.trends.map((point) => [date(point.timestamp), `${point.total} / ${point.critical} / ${point.resolved}`]));

    ensureSpace(document, 42);
    document.fillColor(COLOR.muted).font('Helvetica').fontSize(8)
      .text(
        `Generated ${utcTimestamp(value.generatedAt)}. MTTA includes only incidents with a recorded acknowledgement.`,
        PAGE.left, document.y + 12, { width: WIDTH },
      );

    addPageFooters(document);
    document.end();
    return {
      contentType: 'application/pdf',
      filename: `faultline-system-summary-${date(value.period.to)}.pdf`,
      content: await finished,
    };
  }
}

function cover(document: PDFKit.PDFDocument, report: SystemSummaryReport): void {
  document.rect(0, 0, document.page.width, 146).fill(COLOR.navy);
  document.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(10)
    .text('FAULTLINE  /  APPLICATION OBSERVABILITY', PAGE.left, 28, { width: WIDTH, characterSpacing: 0.7 });
  document.fontSize(26).text('System Summary', PAGE.left, 54, { width: WIDTH });
  document.font('Helvetica').fontSize(10).fillColor('#DCE9F8')
    .text(`${date(report.period.from)} to ${date(report.period.to)}`, PAGE.left, 98, { width: WIDTH });
  document.x = PAGE.left;
  document.y = 174;
}

function contentPage(document: PDFKit.PDFDocument): void {
  document.addPage();
  document.fillColor(COLOR.navy).font('Helvetica-Bold').fontSize(9)
    .text('FAULTLINE  /  SYSTEM SUMMARY', PAGE.left, 30, { width: WIDTH, characterSpacing: 0.5 });
  document.moveTo(PAGE.left, 46).lineTo(PAGE.right, 46).strokeColor(COLOR.border).stroke();
  document.x = PAGE.left;
  document.y = 62;
}

function ensureSpace(document: PDFKit.PDFDocument, height: number): void {
  if (document.y + height > PAGE.bottom) contentPage(document);
}

function section(document: PDFKit.PDFDocument, label: string): void {
  // Reserve enough room for the heading and at least one table/card row so a
  // heading is never stranded at the bottom of a page.
  ensureSpace(document, 80);
  const y = document.y + 12;
  document.fillColor(COLOR.navy).font('Helvetica-Bold').fontSize(14)
    .text(label, PAGE.left, y, { width: WIDTH });
  document.x = PAGE.left;
  document.y = y + 27;
}

function metricGrid(document: PDFKit.PDFDocument, values: readonly (readonly [string, string])[]): void {
  const columns = 3;
  const gap = 10;
  const cardHeight = 62;
  const rowGap = 10;
  const width = (WIDTH - gap * (columns - 1)) / columns;
  const rows = Math.ceil(values.length / columns);
  ensureSpace(document, rows * cardHeight + (rows - 1) * rowGap);
  const startY = document.y;
  values.forEach(([label, value], index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = PAGE.left + column * (width + gap);
    const y = startY + row * (cardHeight + rowGap);
    document.roundedRect(x, y, width, cardHeight, 5).fillAndStroke(COLOR.panel, COLOR.border);
    document.fillColor(COLOR.muted).font('Helvetica-Bold').fontSize(7.5)
      .text(label.toUpperCase(), x + 10, y + 10, { width: width - 20, lineBreak: false });
    document.fillColor(COLOR.text).font('Helvetica-Bold').fontSize(17)
      .text(value, x + 10, y + 30, { width: width - 20, lineBreak: false });
  });
  document.x = PAGE.left;
  document.y = startY + rows * cardHeight + (rows - 1) * rowGap;
}

function keyValueRows(document: PDFKit.PDFDocument, rows: readonly (readonly [string, string])[]): void {
  ensureSpace(document, rows.length * 23);
  const startY = document.y;
  rows.forEach(([label, value], index) => {
    const y = startY + index * 23;
    document.fillColor(COLOR.muted).font('Helvetica').fontSize(9)
      .text(label, PAGE.left, y + 4, { width: 260, lineBreak: false });
    document.fillColor(COLOR.text).font('Helvetica-Bold')
      .text(value, PAGE.left + 270, y + 4, { width: WIDTH - 270, align: 'right', lineBreak: false });
    document.moveTo(PAGE.left, y + 21).lineTo(PAGE.right, y + 21).strokeColor(COLOR.border).stroke();
  });
  document.x = PAGE.left;
  document.y = startY + rows.length * 23;
}

function twoColumnTable(
  document: PDFKit.PDFDocument,
  headers: readonly [string, string],
  rows: readonly (readonly [string, string])[],
): void {
  const values: readonly (readonly [string, string])[] = rows.length
    ? rows
    : [['No data for this period', '—']];
  let index = 0;
  while (index < values.length) {
    ensureSpace(document, 50);
    tableHeader(document, headers);
    while (index < values.length && document.y + 23 <= PAGE.bottom) {
      tableRow(document, values[index]!, index);
      index += 1;
    }
    if (index < values.length) contentPage(document);
  }
}

function tableHeader(document: PDFKit.PDFDocument, headers: readonly [string, string]): void {
  const y = document.y;
  document.rect(PAGE.left, y, WIDTH, 24).fill(COLOR.navy);
  document.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(8)
    .text(headers[0], PAGE.left + 10, y + 8, { width: 365, lineBreak: false });
  document.text(headers[1], PAGE.left + 380, y + 8, { width: 109, align: 'right', lineBreak: false });
  document.x = PAGE.left;
  document.y = y + 24;
}

function tableRow(document: PDFKit.PDFDocument, row: readonly [string, string], index: number): void {
  const y = document.y;
  if (index % 2 === 1) document.rect(PAGE.left, y, WIDTH, 23).fill(COLOR.stripe);
  document.fillColor(COLOR.text).font('Helvetica').fontSize(8.5)
    .text(row[0], PAGE.left + 10, y + 7, { width: 365, ellipsis: true, lineBreak: false });
  document.text(row[1], PAGE.left + 380, y + 7, { width: 109, align: 'right', lineBreak: false });
  document.moveTo(PAGE.left, y + 22).lineTo(PAGE.right, y + 22).strokeColor(COLOR.border).stroke();
  document.x = PAGE.left;
  document.y = y + 23;
}

function addPageFooters(document: PDFKit.PDFDocument): void {
  const range = document.bufferedPageRange();
  for (let index = 0; index < range.count; index++) {
    document.switchToPage(range.start + index);
    document.fillColor(COLOR.muted).font('Helvetica').fontSize(8)
      .text(`Faultline System Summary  •  Page ${index + 1} of ${range.count}`,
        PAGE.left, 775, { align: 'center', width: WIDTH, lineBreak: false });
  }
}

function duration(value: number | null): string {
  if (value === null) return 'N/A';
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}

function date(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function utcTimestamp(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

import {
  Controller,
  Get,
  Header,
  Inject,
  BadRequestException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  IncidentReportBuilder,
  CSV_REPORT_EXPORTER,
  JSON_REPORT_EXPORTER,
  PDF_REPORT_EXPORTER,
  type ReportExporter,
  type IncidentTechnicalReport,
} from '@faultline/reporting';

export const INCIDENT_REPORT_BUILDER = Symbol('faultline.incident-report-builder');

@Controller('reports/incidents')
export class IncidentReportController {
  constructor(
    @Inject(INCIDENT_REPORT_BUILDER)
    private readonly reports: IncidentReportBuilder,
    @Inject(JSON_REPORT_EXPORTER)
    private readonly jsonExporter: ReportExporter<IncidentTechnicalReport>,
    @Inject(CSV_REPORT_EXPORTER)
    private readonly csvExporter: ReportExporter<IncidentTechnicalReport>,
    @Inject(PDF_REPORT_EXPORTER)
    private readonly pdfExporter: ReportExporter<IncidentTechnicalReport>,
  ) {}

  @Get(':incidentId')
  @Header('Cache-Control', 'no-store')
  async generate(
    @Param('incidentId', new ParseUUIDPipe()) incidentId: string,
  ) {
    const report = await this.reports.generateIncidentReport(incidentId);
    if (!report) throw new NotFoundException('Incident not found');
    return report;
  }

  @Get(':incidentId/export')
  @Header('Cache-Control', 'no-store')
  async export(
    @Param('incidentId', new ParseUUIDPipe()) incidentId: string,
    @Query('format') format: unknown,
  ) {
    if (format !== 'json' && format !== 'csv' && format !== 'pdf')
      throw new BadRequestException('Unsupported report export format');
    const report = await this.reports.generateIncidentReport(incidentId);
    if (!report) throw new NotFoundException('Incident not found');
    const exporter =
      format === 'json'
        ? this.jsonExporter
        : format === 'csv'
          ? this.csvExporter
          : this.pdfExporter;
    const result = await exporter.export(report);
    const filename =
      result.filename ?? `faultline-incident-${incidentId}.${format}`;
    return new StreamableFile(
      Buffer.isBuffer(result.content)
        ? result.content
        : Buffer.from(result.content, 'utf8'),
      {
        type: result.contentType,
        disposition: `attachment; filename="${filename}"`,
      },
    );
  }
}

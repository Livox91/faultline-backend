import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { FEATURES } from '@faultline/billing';
import { RequiresFeature } from './auth/context';
import { timestampSchema } from '@faultline/telemetry';
import {
  AnalyticsService,
  incidentTrendBuckets,
  SystemSummaryService,
  SYSTEM_SUMMARY_PDF_EXPORTER,
  type AnalyticsDateRange,
  type IncidentTrendBucket,
  type ReportExporter,
  type SystemSummaryInput,
  type SystemSummaryReport,
} from '@faultline/reporting';

@Controller('analytics/incidents')
@RequiresFeature(FEATURES.REPORTING)
export class IncidentAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  metrics(@Query() query: Record<string, unknown>) {
    return this.analytics.getIncidentMetrics(parseRange(query, false));
  }

  @Get('trends')
  @Header('Cache-Control', 'no-store')
  trends(@Query() query: Record<string, unknown>) {
    const range = parseRange(query, true) as SystemSummaryInput;
    return this.analytics.getIncidentTrends({
      ...range,
      bucket: parseBucket(query.bucket),
    });
  }
}

@Controller('reports/system-summary')
@RequiresFeature(FEATURES.REPORTING)
export class SystemSummaryController {
  constructor(
    private readonly summaries: SystemSummaryService,
    @Inject(SYSTEM_SUMMARY_PDF_EXPORTER)
    private readonly pdfExporter: ReportExporter<SystemSummaryReport>,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  generate(@Query() query: Record<string, unknown>) {
    return this.summaries.generateSystemSummary(
      parseRange(query, true) as SystemSummaryInput,
    );
  }

  @Get('export')
  @Header('Cache-Control', 'no-store')
  async export(@Query() query: Record<string, unknown>) {
    const report = await this.summaries.generateSystemSummary(
      parseRange(query, true) as SystemSummaryInput,
    );
    const result = await this.pdfExporter.export(report);
    return new StreamableFile(
      Buffer.isBuffer(result.content)
        ? result.content
        : Buffer.from(result.content, 'utf8'),
      {
        type: result.contentType,
        disposition: `attachment; filename="${result.filename ?? 'faultline-system-summary.pdf'}"`,
      },
    );
  }
}

function parseRange(
  query: Record<string, unknown>,
  required: boolean,
): AnalyticsDateRange {
  const from = parseDate(query.from, 'from', required);
  const to = parseDate(query.to, 'to', required);
  if (from && to && from > to)
    throw new BadRequestException('from must be before or equal to to');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function parseDate(
  value: unknown,
  field: 'from' | 'to',
  required: boolean,
): Date | undefined {
  if (value === undefined || value === '') {
    if (required) throw new BadRequestException(`${field} is required`);
    return undefined;
  }
  const parsed = timestampSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(`Invalid ${field} timestamp`);
  return new Date(parsed.data);
}

function parseBucket(value: unknown): IncidentTrendBucket {
  if (
    typeof value !== 'string' ||
    !(incidentTrendBuckets as readonly string[]).includes(value)
  )
    throw new BadRequestException('Invalid incident trend bucket');
  return value as IncidentTrendBucket;
}

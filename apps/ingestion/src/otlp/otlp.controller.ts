import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApplicationLogger } from '@faultline/platform';
import { QUEUE, type QueueProducer } from '@faultline/queue';
import { RAW_TELEMETRY_TOPIC } from '@faultline/telemetry';
import {
  CLUSTER_AUTHENTICATOR,
  type ClusterAuthenticator,
} from '../telemetry.controller';
import { translateOtlpLogs } from './translate';
import { translateOtlpMetrics } from './metrics';

/** Collector-only OTLP/HTTP JSON bridge; existing Faultline REST endpoints are unchanged. */
@Controller('v1/otlp')
export class OtlpController {
  constructor(
    @Inject(CLUSTER_AUTHENTICATOR) private readonly auth: ClusterAuthenticator,
    @Inject(QUEUE) private readonly queue: QueueProducer,
    private readonly logger: ApplicationLogger,
  ) {}
  @Post('logs')
  @HttpCode(200)
  async logs(
    @Body() body: unknown,
    @Headers('x-faultline-cluster-id') cluster: unknown,
    @Headers('x-faultline-agent-token') token: unknown,
    @Headers('content-type') contentType: string | undefined,
  ) {
    return this.ingest('logs', body, cluster, token, contentType);
  }
  @Post('metrics')
  @HttpCode(200)
  metrics(
    @Body() body: unknown,
    @Headers('x-faultline-cluster-id') cluster: unknown,
    @Headers('x-faultline-agent-token') token: unknown,
    @Headers('content-type') contentType: string | undefined,
  ) {
    return this.ingest('metrics', body, cluster, token, contentType);
  }
  private async ingest(
    signal: 'logs' | 'metrics',
    body: unknown,
    cluster: unknown,
    token: unknown,
    contentType: string | undefined,
  ) {
    let clusterId: string;
    try {
      clusterId = await this.auth.authenticate(cluster, token);
    } catch (error) {
      this.logger.warn({ event: 'otlp_authentication_rejected' });
      throw error;
    }
    if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new UnsupportedMediaTypeException('OTLP JSON is required');
    let batch: ReturnType<typeof translateOtlpLogs>;
    try {
      batch =
        signal === 'logs'
          ? translateOtlpLogs(body, clusterId)
          : translateOtlpMetrics(body, clusterId);
    } catch {
      this.logger.warn({ event: 'otlp_request_rejected' });
      throw new BadRequestException(
        'Malformed OTLP JSON or batch exceeds 256 records',
      );
    }
    try {
      for (const event of batch.events)
        await this.queue.publish(RAW_TELEMETRY_TOPIC, {
          id: event.id,
          payload: event,
        });
    } catch {
      this.logger.error({ event: 'otlp_publish_failed' });
      throw new ServiceUnavailableException('Telemetry queue unavailable');
    }
    this.logger.log({
      event: 'otlp_batch_accepted',
      signal,
      cluster_id: clusterId,
      accepted: batch.events.length,
      rejected: batch.rejected,
    });
    // OTLP uses 200 with an ExportLogsServiceResponse, including permanent record rejections.
    return batch.rejected
      ? {
          partialSuccess: {
            [signal === 'logs' ? 'rejectedLogRecords' : 'rejectedDataPoints']:
              String(batch.rejected),
            errorMessage: 'Malformed telemetry records rejected',
          },
        }
      : {};
  }
}

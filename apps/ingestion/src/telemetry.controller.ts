import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  APPLICATION_CONFIG,
  ApplicationConfig,
  ApplicationLogger,
} from '@faultline/platform';
import { QUEUE, QueueProducer } from '@faultline/queue';
import {
  RAW_TELEMETRY_TOPIC,
  telemetryEventSchema,
  telemetryRequestSchemas,
} from '@faultline/telemetry';

export const CLUSTER_AUTHENTICATOR = Symbol('faultline.cluster-authenticator');
export interface ClusterAuthenticator {
  authenticate(clusterId: unknown, token: unknown): Promise<string>;
}
@Injectable()
export class DevelopmentClusterAuthenticator implements ClusterAuthenticator {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}
  async authenticate(clusterId: unknown, token: unknown): Promise<string> {
    if (typeof clusterId !== 'string' || !clusterId.trim())
      throw new BadRequestException('Missing cluster ID');
    const expected = this.config.developmentAgentToken;
    if (!expected || this.config.environment === 'production')
      throw new ServiceUnavailableException(
        'Development agent authentication is not configured',
      );
    if (
      typeof token !== 'string' ||
      Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      throw new UnauthorizedException('Invalid agent token');
    return clusterId.trim();
  }
}
@Controller('v1/telemetry')
export class TelemetryController {
  constructor(
    @Inject(CLUSTER_AUTHENTICATOR) private readonly auth: ClusterAuthenticator,
    @Inject(QUEUE) private readonly queue: QueueProducer,
    private readonly logger: ApplicationLogger,
  ) {}
  @Post('logs')
  @HttpCode(202)
  logs(
    @Body() body: unknown,
    @Headers('x-faultline-cluster-id') cluster: unknown,
    @Headers('x-faultline-agent-token') token: unknown,
  ) {
    return this.ingest('log', body, cluster, token);
  }
  @Post('metrics')
  @HttpCode(202)
  metrics(
    @Body() body: unknown,
    @Headers('x-faultline-cluster-id') cluster: unknown,
    @Headers('x-faultline-agent-token') token: unknown,
  ) {
    return this.ingest('metric', body, cluster, token);
  }
  @Post('kubernetes-events')
  @HttpCode(202)
  kubernetes(
    @Body() body: unknown,
    @Headers('x-faultline-cluster-id') cluster: unknown,
    @Headers('x-faultline-agent-token') token: unknown,
  ) {
    return this.ingest('kubernetes', body, cluster, token);
  }
  private async ingest(
    kind: keyof typeof telemetryRequestSchemas,
    body: unknown,
    cluster: unknown,
    token: unknown,
  ) {
    let clusterId: string;
    try {
      clusterId = await this.auth.authenticate(cluster, token);
    } catch (error) {
      this.logger.warn({ event: 'telemetry_authentication_rejected' });
      throw error;
    }
    const result = telemetryRequestSchemas[kind].safeParse(body);
    if (!result.success) {
      this.logger.warn({ event: 'telemetry_validation_rejected', kind });
      throw new BadRequestException({
        message: 'Malformed telemetry or unsupported telemetry type',
        fields: result.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    const request = result.data;
    if (request.clusterId !== undefined && request.clusterId !== clusterId)
      throw new BadRequestException('Cluster ID does not match header');
    const normalized = {
      ...request,
      kind,
      clusterId,
      id: request.id ?? randomUUID(),
      ingestedAt: new Date().toISOString(),
    };
    if ('involvedObject' in request)
      Object.assign(normalized, {
        involvedObject: {
          ...request.involvedObject,
          clusterId: request.involvedObject.clusterId ?? clusterId,
        },
      });
    const parsed = telemetryEventSchema.safeParse(normalized);
    if (!parsed.success)
      throw new BadRequestException(
        'Malformed telemetry or resource cluster mismatch',
      );
    const event = parsed.data;
    try {
      await this.queue.publish(RAW_TELEMETRY_TOPIC, {
        id: event.id,
        payload: event,
      });
    } catch {
      this.logger.error({
        event: 'telemetry_publish_failed',
        event_id: event.id,
      });
      throw new ServiceUnavailableException('Telemetry queue unavailable');
    }
    this.logger.log({
      event: 'telemetry_accepted',
      event_id: event.id,
      type: event.kind,
      cluster_id: event.clusterId,
    });
    return {
      status: 'accepted',
      eventId: event.id,
      ingestedAt: event.ingestedAt,
    };
  }
}

import {
  Inject,
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ApplicationLogger } from '@faultline/platform';
import {
  QUEUE,
  QueueConsumer,
  QueueMessage,
  QueueSubscription,
} from '@faultline/queue';
import {
  RAW_TELEMETRY_TOPIC,
  ingestedTelemetryEventSchema,
} from '@faultline/telemetry';

@Injectable()
export class TelemetryConsumer implements OnModuleInit, OnModuleDestroy {
  private subscription?: QueueSubscription;
  constructor(
    @Inject(QUEUE) private readonly queue: QueueConsumer,
    private readonly logger: ApplicationLogger,
  ) {}
  async onModuleInit() {
    this.subscription = await this.queue.subscribe(
      RAW_TELEMETRY_TOPIC,
      async (message) => {
        await this.process(message);
      },
    );
  }
  async onModuleDestroy() {
    await this.subscription?.close();
  }
  async process(message: QueueMessage) {
    const parsed = ingestedTelemetryEventSchema.safeParse(message.payload);
    if (!parsed.success || parsed.data.id !== message.id) {
      this.logger.warn({
        event: 'processor_event_rejected',
        status: 'rejected',
      });
      throw new Error(
        'Malformed internal telemetry event or unsupported telemetry type',
      );
    }
    const event = parsed.data;
    try {
      const processed = {
        ...event,
        processedAt: new Date().toISOString(),
        processor: 'faultline-processor',
        status: 'processed' as const,
      };
      this.logger.log({
        event: 'telemetry_processed',
        event_id: processed.id,
        type: processed.kind.toUpperCase(),
        cluster_id: processed.clusterId,
        service: processed.service,
        timestamp: processed.timestamp,
        ingestedAt: processed.ingestedAt,
        processedAt: processed.processedAt,
        processor: processed.processor,
        status: processed.status,
      });
      return processed;
    } catch {
      this.logger.error({
        event: 'processor_failed',
        event_id: event.id,
        status: 'failed',
      });
      throw new Error('Telemetry processing failed');
    }
  }
}

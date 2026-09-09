import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  QUEUE,
  type Queue,
  type QueueMessage,
  type QueueSubscription,
} from '@faultline/queue';
import {
  RAW_TELEMETRY_TOPIC,
  TELEMETRY_STORE,
  TelemetryBatcher,
  ingestedTelemetryEventSchema,
  toStoredKubernetesEventRecord,
  toStoredLogRecord,
  toStoredMetricRecord,
  type StoredKubernetesEventRecord,
  type StoredLogRecord,
  type StoredMetricRecord,
  type TelemetryPayloadLimits,
  type TelemetryStore,
} from '@faultline/telemetry';

/**
 * Telemetry history writer.
 *
 * This runs as its own broker consumer with its own durable cursor, deliberately not as
 * a step inside the processor. Detection reads `telemetry.raw` on one consumer and this
 * writer reads it on another, so a ClickHouse outage stalls and retries only this side
 * while rules, anomalies and incidents continue unaffected.
 *
 * Acknowledgement is tied to the batch: `TelemetryBatcher.add` resolves once the batch
 * containing the message has been written, and only then does the handler return, so an
 * unwritten message is redelivered rather than silently lost. That requires more than
 * one in-flight message, hence the raised `maxAckPending`.
 */
@Injectable()
export class TelemetryStorageConsumer implements OnModuleInit, OnModuleDestroy {
  private subscription?: QueueSubscription;
  private readonly logs: TelemetryBatcher<StoredLogRecord>;
  private readonly metrics: TelemetryBatcher<StoredMetricRecord>;
  private readonly kubernetesEvents: TelemetryBatcher<StoredKubernetesEventRecord>;
  private readonly payloadLimits: TelemetryPayloadLimits;

  constructor(
    @Inject(QUEUE) private readonly queue: Queue,
    @Inject(TELEMETRY_STORE) private readonly store: TelemetryStore,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly logger: ApplicationLogger,
  ) {
    const { batchMaxSize, batchMaxAgeMs, payloadLimits } =
      config.telemetryStorage;
    this.payloadLimits = payloadLimits;
    const options = {
      maxBatchSize: batchMaxSize,
      maxBatchAgeMs: batchMaxAgeMs,
    };
    this.logs = new TelemetryBatcher<StoredLogRecord>({
      ...options,
      flush: (records) =>
        this.write('log', () => store.storeLogs(records), records.length),
    });
    this.metrics = new TelemetryBatcher<StoredMetricRecord>({
      ...options,
      flush: (records) =>
        this.write('metric', () => store.storeMetrics(records), records.length),
    });
    this.kubernetesEvents = new TelemetryBatcher<StoredKubernetesEventRecord>({
      ...options,
      flush: (records) =>
        this.write(
          'kubernetes',
          () => store.storeKubernetesEvents(records),
          records.length,
        ),
    });
  }

  async onModuleInit(): Promise<void> {
    this.subscription = await this.queue.subscribe(
      RAW_TELEMETRY_TOPIC,
      (message) => this.process(message),
      {
        // Its own durable consumer, so storage and the processor each see every event
        // rather than splitting the subject between them.
        consumerGroup: this.config.telemetryStorage.consumerGroup,
        // A batch's worth of messages must be in flight for batching to be possible.
        maxAckPending: Math.max(
          2,
          this.config.telemetryStorage.batchMaxSize * 2,
        ),
        // Redelivery must not fire while a batch is still waiting on its age timer.
        ackWaitMs: Math.max(
          30_000,
          this.config.telemetryStorage.batchMaxAgeMs * 10,
        ),
      },
    );
    this.logger.log({
      event: 'telemetry_storage_started',
      batch_max_size: this.config.telemetryStorage.batchMaxSize,
      batch_max_age_ms: this.config.telemetryStorage.batchMaxAgeMs,
      consumer_group: this.config.telemetryStorage.consumerGroup,
    });
  }

  /** Graceful shutdown: flush partial batches before the process exits. */
  async onModuleDestroy(): Promise<void> {
    await this.subscription?.close();
    const results = await Promise.allSettled([
      this.logs.close(),
      this.metrics.close(),
      this.kubernetesEvents.close(),
    ]);
    const failed = results.filter((result) => result.status === 'rejected');
    this.logger.log({
      event: 'telemetry_storage_stopped',
      flushed: results.length - failed.length,
      failed: failed.length,
    });
  }

  async process(message: QueueMessage): Promise<void> {
    const parsed = ingestedTelemetryEventSchema.safeParse(message.payload);
    if (!parsed.success || parsed.data.id !== message.id) {
      this.logger.warn({
        event: 'telemetry_storage_event_rejected',
        status: 'rejected',
      });
      throw new Error('Malformed internal telemetry event');
    }
    // Storage records when it persisted the event; the processor timestamps its own path.
    const event = { ...parsed.data, processedAt: new Date().toISOString() };
    switch (event.kind) {
      case 'log':
        return this.logs.add(toStoredLogRecord(event, this.payloadLimits));
      case 'metric':
        return this.metrics.add(
          toStoredMetricRecord(event, this.payloadLimits),
        );
      case 'kubernetes':
        return this.kubernetesEvents.add(
          toStoredKubernetesEventRecord(event, this.payloadLimits),
        );
    }
  }

  /** Flushes pending batches immediately; used by tests and shutdown paths. */
  async flush(): Promise<void> {
    await Promise.all([
      this.logs.flush(),
      this.metrics.flush(),
      this.kubernetesEvents.flush(),
    ]);
  }

  private async write(
    kind: string,
    persist: () => Promise<{ written: number }>,
    size: number,
  ): Promise<void> {
    try {
      const { written } = await persist();
      this.logger.log({
        event: 'telemetry_batch_written',
        kind,
        batch_size: size,
        written,
      });
    } catch (error) {
      // Rethrow so every message in the batch is negatively acknowledged and retried.
      this.logger.error({
        event: 'telemetry_batch_failed',
        kind,
        batch_size: size,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw new Error(`Telemetry batch persistence failed for ${kind}`);
    }
  }

  /** Exposed for readiness: reports whether the store is reachable. */
  get telemetryStore(): TelemetryStore {
    return this.store;
  }
}

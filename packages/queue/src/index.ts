import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  StringCodec,
  connect,
  consumerOpts,
  createInbox,
  headers,
  type JetStreamClient,
  type JetStreamManager,
  type JetStreamSubscription,
  type NatsConnection,
} from 'nats';

export const QUEUE = Symbol('faultline.queue');
export const EVENT_TOPICS = {
  telemetryRaw: 'telemetry.raw',
  telemetryNormalized: 'telemetry.normalized',
  anomaliesDetected: 'anomalies.detected',
  anomaliesResolved: 'anomalies.resolved',
  incidentsUpdated: 'incidents.updated',
} as const;
export const DEAD_LETTER_PREFIX = 'deadletter';

export interface MessageEnvelope<TPayload = unknown> {
  messageId: string;
  eventType: string;
  timestamp: string;
  source: string;
  schemaVersion: number;
  payload: TPayload;
}
export interface QueueMessage<TPayload = unknown> {
  id: string;
  payload: TPayload;
  headers?: Readonly<Record<string, string>>;
}
export interface QueueProducer<TPayload = unknown> {
  publish(topic: string, message: QueueMessage<TPayload>): Promise<void>;
  close(): Promise<void>;
}
export type QueueMessageHandler<TPayload = unknown> = (
  message: QueueMessage<TPayload>,
) => Promise<void>;
export interface QueueSubscription {
  close(): Promise<void>;
}
export interface QueueConsumer<TPayload = unknown> {
  subscribe(
    topic: string,
    handler: QueueMessageHandler<TPayload>,
  ): Promise<QueueSubscription>;
  close(): Promise<void>;
}
export interface Queue extends QueueProducer, QueueConsumer {
  readonly deliveryGuarantee?: 'at-most-once' | 'at-least-once';
  ping?(): Promise<void>;
}

export function createEnvelope<T>(
  topic: string,
  message: QueueMessage<T>,
  source = 'faultline',
): MessageEnvelope<T> {
  return {
    messageId: message.id,
    eventType: message.headers?.eventType ?? topic,
    timestamp: message.headers?.timestamp ?? new Date().toISOString(),
    source: message.headers?.source ?? source,
    schemaVersion: Number(message.headers?.schemaVersion ?? 1),
    payload: message.payload,
  };
}

export function parseEnvelope(value: unknown): MessageEnvelope {
  if (!value || typeof value !== 'object')
    throw new Error('Message envelope must be an object');
  const input = value as Partial<MessageEnvelope>;
  if (
    typeof input.messageId !== 'string' ||
    !input.messageId ||
    typeof input.eventType !== 'string' ||
    !input.eventType ||
    typeof input.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(input.timestamp)) ||
    typeof input.source !== 'string' ||
    !input.source ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion! < 1 ||
    !Object.hasOwn(input, 'payload')
  )
    throw new Error('Invalid message envelope');
  if (input.schemaVersion !== 1)
    throw new Error(`Unsupported schema version: ${input.schemaVersion}`);
  return input as MessageEnvelope;
}

export interface NatsJetStreamOptions {
  servers: string;
  clientId: string;
  consumerGroup: string;
  maxDeliver?: number;
  retryDelayMs?: number;
}

/** Durable, at-least-once JetStream adapter with bounded retry and preserved dead letters. */
export class NatsJetStreamQueue implements Queue {
  readonly name = 'nats';
  readonly deliveryGuarantee = 'at-least-once' as const;
  private readonly codec = StringCodec();
  private readonly subscriptions = new Set<{
    sub: JetStreamSubscription;
    task: Promise<void>;
    pending: Set<Promise<void>>;
  }>();
  private closed = false;
  private constructor(
    private readonly connection: NatsConnection,
    private readonly jetstream: JetStreamClient,
    private readonly manager: JetStreamManager,
    private readonly options: Required<NatsJetStreamOptions>,
  ) {}

  static async connect(
    options: NatsJetStreamOptions,
  ): Promise<NatsJetStreamQueue> {
    const connection = await connect({
      servers: options.servers,
      name: options.clientId,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1_000,
    });
    const manager = await connection.jetstreamManager();
    const queue = new NatsJetStreamQueue(
      connection,
      connection.jetstream(),
      manager,
      {
        ...options,
        maxDeliver: options.maxDeliver ?? 5,
        retryDelayMs: options.retryDelayMs ?? 1_000,
      },
    );
    await queue.ensureStreams();
    return queue;
  }

  async publish(topic: string, message: QueueMessage): Promise<void> {
    if (this.closed) throw new Error('Queue closed');
    const envelope = createEnvelope(topic, message, this.options.clientId);
    await this.jetstream.publish(
      topic,
      this.codec.encode(JSON.stringify(envelope)),
      { msgID: message.id },
    );
  }

  async subscribe(
    topic: string,
    handler: QueueMessageHandler,
  ): Promise<QueueSubscription> {
    if (this.closed) throw new Error('Queue closed');
    const durable = sanitize(`${this.options.consumerGroup}_${topic}`);
    const opts = consumerOpts();
    opts
      .durable(durable)
      .manualAck()
      .ackExplicit()
      .ackWait(30_000)
      .maxDeliver(this.options.maxDeliver)
      .maxAckPending(1)
      .deliverAll()
      .deliverTo(createInbox())
      .queue(this.options.consumerGroup);
    const sub = await this.jetstream.subscribe(topic, opts);
    const pending = new Set<Promise<void>>();
    const task = (async () => {
      for await (const raw of sub) {
        const delivery = this.handle(
          topic,
          raw.data,
          raw.info.redeliveryCount,
          handler,
          raw.headers?.get('Faultline-Failure-Reason'),
          raw.headers?.get('Faultline-Original-Topic'),
        )
          .then(() => raw.ack())
          .catch(async (error: unknown) => {
            const reason =
              error instanceof Error
                ? error.message
                : 'Unknown handler failure';
            if (raw.info.redeliveryCount >= this.options.maxDeliver) {
              const id =
                raw.headers?.get('Nats-Msg-Id') ?? `${durable}-${raw.seq}`;
              await this.jetstream.publish(
                `${DEAD_LETTER_PREFIX}.${topic}`,
                raw.data,
                {
                  msgID: `dlq-${id}`,
                  headers: (() => {
                    const h = headers();
                    h.set('Faultline-Failure-Reason', reason.slice(0, 512));
                    h.set('Faultline-Original-Topic', topic);
                    return h;
                  })(),
                },
              );
              console.error(
                JSON.stringify({
                  event: 'message_dead_lettered',
                  topic,
                  message_id: id,
                  reason,
                  attempts: raw.info.redeliveryCount,
                }),
              );
              raw.ack();
            } else raw.nak(this.options.retryDelayMs);
          });
        pending.add(delivery);
        void delivery.finally(() => pending.delete(delivery));
      }
    })();
    const tracked = { sub, task, pending };
    this.subscriptions.add(tracked);
    return {
      close: async () => {
        sub.unsubscribe();
        await Promise.allSettled([...pending]);
        await task;
        this.subscriptions.delete(tracked);
      },
    };
  }

  async ping(): Promise<void> {
    await this.connection.flush();
    await this.manager.getAccountInfo();
  }
  /** Forces a transport reconnect; primarily useful for deployment smoke tests. */
  async reconnect(): Promise<void> {
    await this.connection.reconnect();
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.ping();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      [...this.subscriptions].map(async ({ sub, pending, task }) => {
        sub.unsubscribe();
        await Promise.allSettled([...pending]);
        await task;
      }),
    );
    this.subscriptions.clear();
    await this.connection.drain();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  private async handle(
    topic: string,
    data: Uint8Array,
    attempt: number,
    handler: QueueMessageHandler,
    failureReason?: string,
    originalTopic?: string,
  ): Promise<void> {
    const envelope = parseEnvelope(JSON.parse(this.codec.decode(data)));
    if (
      !topic.startsWith(`${DEAD_LETTER_PREFIX}.`) &&
      envelope.eventType !== topic
    )
      throw new Error('Envelope eventType does not match topic');
    await handler({
      id: envelope.messageId,
      payload: envelope.payload,
      headers: {
        eventType: envelope.eventType,
        timestamp: envelope.timestamp,
        source: envelope.source,
        schemaVersion: String(envelope.schemaVersion),
        deliveryAttempt: String(attempt),
        ...(failureReason ? { failureReason } : {}),
        ...(originalTopic ? { originalTopic } : {}),
      },
    });
  }

  private async ensureStreams(): Promise<void> {
    await this.ensureStream('FAULTLINE_EVENTS', Object.values(EVENT_TOPICS));
    await this.ensureStream('FAULTLINE_DEAD_LETTERS', [
      `${DEAD_LETTER_PREFIX}.>`,
    ]);
  }
  private async ensureStream(name: string, subjects: string[]): Promise<void> {
    try {
      const info = await this.manager.streams.info(name);
      const merged = [...new Set([...info.config.subjects, ...subjects])];
      if (merged.length !== info.config.subjects.length)
        await this.manager.streams.update(name, {
          ...info.config,
          subjects: merged,
        });
    } catch {
      await this.manager.streams.add({
        name,
        subjects,
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        duplicate_window: 120_000_000_000,
      });
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

/** Unit-test adapter: process-local, bounded, at-most-once, and non-durable. */
export class InMemoryQueue implements Queue {
  readonly deliveryGuarantee = 'at-most-once' as const;
  private readonly subscriptions = new Map<
    string,
    Set<{ handler: QueueMessageHandler; pending: Set<Promise<void>> }>
  >();
  private closed = false;
  private pendingCount = 0;
  constructor(
    private readonly onFailure: (topic: string) => void = () => {},
    private readonly capacity = 1000,
  ) {}
  async publish(topic: string, message: QueueMessage): Promise<void> {
    const subscribers = this.subscriptions.get(topic);
    if (this.closed || !subscribers?.size) throw new Error('Queue unavailable');
    if (this.pendingCount + subscribers.size > this.capacity)
      throw new Error('Queue capacity exceeded');
    for (const sub of subscribers) {
      const copy = structuredClone(message);
      this.pendingCount++;
      const task = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => sub.handler(copy))
        .catch(() => {
          try {
            this.onFailure(topic);
          } catch {}
        })
        .finally(() => {
          sub.pending.delete(task);
          this.pendingCount--;
        });
      sub.pending.add(task);
    }
  }
  async subscribe(
    topic: string,
    handler: QueueMessageHandler,
  ): Promise<QueueSubscription> {
    if (this.closed) throw new Error('Queue closed');
    const sub = { handler, pending: new Set<Promise<void>>() };
    const subscribers = this.subscriptions.get(topic) ?? new Set();
    this.subscriptions.set(topic, subscribers);
    subscribers.add(sub);
    return {
      close: async () => {
        subscribers.delete(sub);
        await Promise.all(sub.pending);
      },
    };
  }
  async ping(): Promise<void> {
    if (this.closed) throw new Error('Queue closed');
  }
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.subscriptions.values()].flatMap((subs) =>
      [...subs].flatMap((sub) => [...sub.pending]),
    );
    this.subscriptions.clear();
    await Promise.all(pending);
  }
}

let developmentQueue: Queue | undefined;
export function getDevelopmentQueue(): Queue {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development queue is disabled in production');
  return (developmentQueue ??= new InMemoryQueue((topic) =>
    console.error(JSON.stringify({ event: 'queue_handler_failed', topic })),
  ));
}

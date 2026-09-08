/** Injection token for the transport abstraction. */
export const QUEUE = Symbol('faultline.queue');

export interface QueueMessage<TPayload = unknown> {
  id: string;
  payload: TPayload;
  headers?: Readonly<Record<string, string>>;
}

export interface QueueProducer<TPayload = unknown> {
  /** Resolve when the adapter accepts the message; delivery guarantees are adapter-specific. */
  publish(topic: string, message: QueueMessage<TPayload>): Promise<void>;
  close(): Promise<void>;
}

/** Resolve after processing succeeds; reject to signal failure to the future adapter. */
export type QueueMessageHandler<TPayload = unknown> = (
  message: QueueMessage<TPayload>,
) => Promise<void>;

export interface QueueSubscription {
  /** Stop receiving messages and await in-flight handlers. */
  close(): Promise<void>;
}

export interface QueueConsumer<TPayload = unknown> {
  subscribe(
    topic: string,
    handler: QueueMessageHandler<TPayload>,
  ): Promise<QueueSubscription>;
  /** Close all subscriptions and await in-flight handlers. */
  close(): Promise<void>;
}

export interface Queue extends QueueProducer, QueueConsumer {}

/** DEVELOPMENT ONLY: process-local, bounded, at-most-once delivery; no retries or persistence.
 * A publish requires an active subscriber. Handler failures are reported, never unhandled.
 */
export class InMemoryQueue implements Queue {
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
    const copies = [...subscribers].map((sub) => ({
      sub,
      message: structuredClone(message),
    }));
    for (const { sub, message: copy } of copies) {
      this.pendingCount++;
      const task = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => sub.handler(copy))
        .catch(() => {
          try {
            this.onFailure(topic);
          } catch {
            /* Error reporting must not reject delivery tasks. */
          }
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
/** Composition-root helper. Consumers inject QUEUE and never access this directly. */
export function getDevelopmentQueue(): Queue {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development queue is disabled in production');
  return (developmentQueue ??= new InMemoryQueue((topic) =>
    console.error(JSON.stringify({ event: 'queue_handler_failed', topic })),
  ));
}

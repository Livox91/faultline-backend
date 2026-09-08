/** No provider is registered until an adapter is implemented. */
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
export type QueueMessageHandler<TPayload = unknown> =
  (message: QueueMessage<TPayload>) => Promise<void>;

export interface QueueSubscription {
  /** Stop receiving messages and await in-flight handlers. */
  close(): Promise<void>;
}

export interface QueueConsumer<TPayload = unknown> {
  subscribe(topic: string, handler: QueueMessageHandler<TPayload>): Promise<QueueSubscription>;
  /** Close all subscriptions and await in-flight handlers. */
  close(): Promise<void>;
}

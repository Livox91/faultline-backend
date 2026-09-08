import { createClient, type RedisClientType } from 'redis';

export class RedisConnection {
  readonly name = 'redis';
  readonly client: RedisClientType;
  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on('error', () => {});
  }
  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }
  async ping(): Promise<void> {
    await this.client.ping();
  }
  async disconnect(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.disconnect();
  }
}

export const PROCESSING_LEDGER = Symbol('faultline.processing-ledger');
export interface ProcessingLedger {
  begin(messageId: string, redelivery?: boolean): Promise<boolean>;
  complete(messageId: string): Promise<void>;
  release(messageId: string): Promise<void>;
}

/** SET NX makes concurrent/redelivered work idempotent; failed attempts release their claim. */
export class RedisProcessingLedger implements ProcessingLedger {
  constructor(
    private readonly redis: RedisConnection,
    private readonly ttlSeconds = 24 * 60 * 60,
  ) {}
  private key(id: string): string {
    return `faultline:processed:${id}`;
  }
  async begin(id: string, redelivery = false): Promise<boolean> {
    const result = await this.redis.client.set(this.key(id), 'processing', {
      NX: true,
      EX: 300,
    });
    if (result === 'OK') return true;
    const state = await this.redis.client.get(this.key(id));
    if (redelivery && state === 'processing') {
      await this.redis.client.set(this.key(id), 'processing', { EX: 300 });
      return true;
    }
    return false;
  }
  async complete(id: string): Promise<void> {
    await this.redis.client.set(this.key(id), 'complete', {
      EX: this.ttlSeconds,
    });
  }
  async release(id: string): Promise<void> {
    await this.redis.client.del(this.key(id));
  }
}

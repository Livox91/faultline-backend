export interface TelemetryBatcherOptions<T> {
  /** Flush as soon as this many items are buffered. */
  maxBatchSize: number;
  /** Flush when the oldest buffered item reaches this age, even if the batch is small. */
  maxBatchAgeMs: number;
  flush(items: readonly T[]): Promise<void>;
}

interface PendingBatch<T> {
  items: T[];
  /** Settles when this exact batch has been written, so callers can ack afterwards. */
  settled: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  timer?: NodeJS.Timeout;
}

/**
 * Size- and age-bounded write buffer.
 *
 * `add` resolves only after the batch containing the item has been flushed, which lets
 * a broker consumer acknowledge exactly the messages that reached storage. Flushes are
 * serialized so a slow write cannot interleave two batches into the same table.
 */
export class TelemetryBatcher<T> {
  private current?: PendingBatch<T>;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: TelemetryBatcherOptions<T>) {
    if (!Number.isSafeInteger(options.maxBatchSize) || options.maxBatchSize < 1)
      throw new Error('maxBatchSize must be a positive integer');
    if (
      !Number.isSafeInteger(options.maxBatchAgeMs) ||
      options.maxBatchAgeMs < 1
    )
      throw new Error('maxBatchAgeMs must be a positive integer');
  }

  get pending(): number {
    return this.current?.items.length ?? 0;
  }

  add(item: T): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Batcher closed'));
    const batch = (this.current ??= this.open());
    batch.items.push(item);
    if (batch.items.length >= this.options.maxBatchSize) this.dispatch();
    return batch.settled;
  }

  /** Writes whatever is buffered now and resolves when that write completes. */
  async flush(): Promise<void> {
    const batch = this.current;
    this.dispatch();
    await (batch ? batch.settled : this.chain);
  }

  /** Flushes remaining work; used by graceful shutdown. Rejects if the last write fails. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.chain;
      return;
    }
    this.closed = true;
    await this.flush();
  }

  private open(): PendingBatch<T> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const batch: PendingBatch<T> = { items: [], settled, resolve, reject };
    // Age-based flush keeps low-traffic clusters from sitting unwritten indefinitely.
    batch.timer = setTimeout(() => {
      if (this.current === batch) this.dispatch();
    }, this.options.maxBatchAgeMs);
    batch.timer.unref?.();
    // Nothing awaits `settled` until `add` returns it; avoid an unhandled rejection.
    void settled.catch(() => {});
    return batch;
  }

  private dispatch(): void {
    const batch = this.current;
    if (!batch) return;
    this.current = undefined;
    if (batch.timer) clearTimeout(batch.timer);
    if (!batch.items.length) {
      batch.resolve();
      return;
    }
    this.chain = this.chain.then(async () => {
      try {
        await this.options.flush(batch.items);
        batch.resolve();
      } catch (error) {
        batch.reject(error);
      }
    });
  }
}

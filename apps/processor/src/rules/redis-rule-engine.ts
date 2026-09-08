import type { Anomaly } from '@faultline/incidents';
import type { TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';
import type { RedisConnection } from '../infrastructure/redis';
import type { RuleEngine } from './contracts';
import { InMemoryRuleEngine } from './in-memory-rule-engine';

/** Persists anomaly dedupe, active windows, counters, evidence, and lifecycle state in Redis. */
export class RedisRuleEngine implements RuleEngine {
  private pending = false;
  constructor(
    private readonly redis: RedisConnection,
    private readonly engine: InMemoryRuleEngine,
    private readonly key = 'faultline:rules:state:v1',
    private readonly ttlSeconds = 24 * 60 * 60,
  ) {}
  async evaluate(
    event: TelemetryEvent,
    state?: ResourceState,
  ): Promise<readonly Anomaly[]> {
    const stored = await this.redis.client.get(this.key);
    if (stored) this.engine.importState(JSON.parse(stored));
    const result = this.engine.evaluate(event, state);
    this.pending = true;
    return result;
  }

  async commit(): Promise<void> {
    if (!this.pending) return;
    await this.redis.client.set(
      this.key,
      JSON.stringify(this.engine.exportState()),
      { EX: this.ttlSeconds },
    );
    this.pending = false;
  }

  async rollback(): Promise<void> {
    this.pending = false;
    const stored = await this.redis.client.get(this.key);
    this.engine.importState(stored ? JSON.parse(stored) : { version: 1 });
  }
}

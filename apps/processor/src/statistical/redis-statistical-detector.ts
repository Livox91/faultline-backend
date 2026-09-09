import type { Anomaly } from '@faultline/incidents';
import type { TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';
import type { RedisConnection } from '../infrastructure/redis';
import type { StatisticalDetector } from './contracts';
import type { InMemoryStatisticalDetector } from './statistical-detector';

/**
 * Persists rolling sample windows and anomaly lifecycle state in Redis.
 *
 * Mirrors `RedisRuleEngine` deliberately: both are operational state that must survive a
 * processor restart without becoming a system of record. Without it, every restart would
 * empty the sample windows and silently reset every hysteresis and cooldown counter.
 */
export class RedisStatisticalDetector implements StatisticalDetector {
  private pending = false;
  constructor(
    private readonly redis: RedisConnection,
    private readonly detector: InMemoryStatisticalDetector,
    private readonly key = 'faultline:statistical:state:v1',
    private readonly ttlSeconds = 24 * 60 * 60,
  ) {}

  async detect(
    event: TelemetryEvent,
    state?: ResourceState,
  ): Promise<readonly Anomaly[]> {
    const stored = await this.redis.client.get(this.key);
    if (stored) this.detector.importState(JSON.parse(stored));
    const result = await this.detector.detect(event, state);
    this.pending = true;
    return result;
  }

  async commit(): Promise<void> {
    if (!this.pending) return;
    await this.redis.client.set(
      this.key,
      JSON.stringify(this.detector.exportState()),
      { EX: this.ttlSeconds },
    );
    this.pending = false;
  }

  async rollback(): Promise<void> {
    this.pending = false;
    const stored = await this.redis.client.get(this.key);
    this.detector.importState(stored ? JSON.parse(stored) : { version: 1 });
  }
}

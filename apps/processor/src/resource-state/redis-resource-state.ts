import type { MetricEvent, TelemetryEvent } from '@faultline/telemetry';
import { restartChange, utilizationPercent } from './calculations';
import {
  fieldFor,
  identityFor,
  resourceStateKey,
  type FieldValue,
} from './in-memory-resource-state';
import type {
  ResourceIdentity,
  ResourceState,
  ResourceStateStore,
} from './resource-state';
import type { RedisConnection } from '../infrastructure/redis';

interface StoredSample {
  value: FieldValue;
  timestamp: string;
  time: string;
}
interface StoredEntry {
  identity: ResourceIdentity;
  fields: Record<string, StoredSample>;
}

export class RedisResourceState implements ResourceStateStore {
  constructor(
    private readonly redis: RedisConnection,
    private readonly ttlMs = 120_000,
  ) {}
  async sweep(): Promise<void> {
    /* Redis key TTL is the sweep. */
  }
  async update(event: MetricEvent): Promise<ResourceState | undefined> {
    const identity = identityFor(event);
    const mapped = fieldFor(event);
    const millis = Date.parse(event.timestamp);
    const now = Date.now();
    if (
      !identity ||
      !mapped ||
      !Number.isFinite(millis) ||
      millis <= now - this.ttlMs ||
      millis > now + 60_000
    )
      return;
    const fraction = /\.(\d+)/.exec(event.timestamp)?.[1] ?? '';
    const time =
      BigInt(millis) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(3, 9));
    const redisKey = this.key(identity);
    const raw = await this.redis.client.get(redisKey);
    const entry: StoredEntry = raw
      ? (JSON.parse(raw) as StoredEntry)
      : { identity, fields: {} };
    this.removeExpired(entry, now);
    const previous = entry.fields[mapped.field];
    if (previous && time <= BigInt(previous.time)) return this.snapshot(entry);
    const value =
      mapped.field === 'restart'
        ? restartChange(
            previous
              ? (previous.value as Record<string, number>).restartCount
              : undefined,
            mapped.value as number,
          )
        : mapped.value;
    entry.fields[mapped.field] = {
      value,
      timestamp: event.timestamp,
      time: String(time),
    };
    entry.identity = {
      ...entry.identity,
      ...Object.fromEntries(
        Object.entries(identity).filter(([, value]) => value !== undefined),
      ),
    };
    await this.redis.client.set(redisKey, JSON.stringify(entry), {
      PX: this.ttlMs,
    });
    return this.snapshot(entry);
  }
  async get(identity: ResourceIdentity): Promise<ResourceState | undefined> {
    return this.load(identity);
  }
  async findForTelemetry(
    event: TelemetryEvent,
  ): Promise<ResourceState | undefined> {
    for (const identity of identitiesForTelemetry(event)) {
      const state = await this.load(identity);
      if (state) return state;
    }
    return undefined;
  }
  private key(identity: ResourceIdentity): string {
    return `faultline:resource:${Buffer.from(resourceStateKey(identity)).toString('base64url')}`;
  }
  private async load(
    identity: ResourceIdentity,
  ): Promise<ResourceState | undefined> {
    const key = this.key(identity);
    const raw = await this.redis.client.get(key);
    if (!raw) return;
    const entry = JSON.parse(raw) as StoredEntry;
    this.removeExpired(entry, Date.now());
    if (!Object.keys(entry.fields).length) {
      await this.redis.client.del(key);
      return;
    }
    return this.snapshot(entry);
  }
  private removeExpired(entry: StoredEntry, now: number): void {
    for (const [field, sample] of Object.entries(entry.fields))
      if (Date.parse(sample.timestamp) + this.ttlMs <= now)
        delete entry.fields[field];
  }
  private snapshot(entry: StoredEntry): ResourceState {
    const values: Record<string, unknown> = {};
    const fieldTimestamps: Record<string, string> = {};
    let latest: StoredSample | undefined;
    for (const [field, sample] of Object.entries(entry.fields)) {
      fieldTimestamps[field] = sample.timestamp;
      if (!latest || BigInt(sample.time) > BigInt(latest.time)) latest = sample;
      if (field === 'restart' || field === 'containerStatus')
        Object.assign(values, sample.value);
      else if (field.startsWith('condition:'))
        ((values.nodeConditions ??= {}) as Record<string, unknown>)[
          field.slice(10)
        ] = sample.value;
      else values[field] = sample.value;
    }
    return {
      ...entry.identity,
      ...values,
      cpuUtilizationPercent: utilizationPercent(
        values.cpuUsage as number | undefined,
        values.cpuLimit as number | undefined,
      ),
      memoryUtilizationPercent: utilizationPercent(
        values.memoryUsage as number | undefined,
        values.memoryLimit as number | undefined,
      ),
      updatedAt: latest!.timestamp,
      fieldTimestamps,
    } as ResourceState;
  }
}

function identitiesForTelemetry(event: TelemetryEvent): ResourceIdentity[] {
  const attr = event.attributes['k8s.pod.uid'];
  const podUid =
    typeof attr === 'string'
      ? attr
      : event.kind === 'kubernetes' && event.involvedObject.kind === 'Pod'
        ? event.involvedObject.uid
        : undefined;
  const namespace =
    event.namespace ??
    (event.kind === 'kubernetes' ? event.involvedObject.namespace : undefined);
  const pod =
    event.pod ??
    (event.kind === 'kubernetes' && event.involvedObject.kind === 'Pod'
      ? event.involvedObject.name
      : undefined);
  const workload =
    event.workload ??
    (event.kind === 'kubernetes' && event.involvedObject.kind === 'Deployment'
      ? event.involvedObject.name
      : undefined);
  const node =
    event.node ??
    (event.kind === 'kubernetes' && event.involvedObject.kind === 'Node'
      ? event.involvedObject.name
      : undefined);
  const result: ResourceIdentity[] = [];
  if (pod && namespace && event.container)
    result.push({
      clusterId: event.clusterId,
      scope: 'container',
      namespace,
      pod,
      podUid,
      container: event.container,
    });
  if (pod && namespace)
    result.push({
      clusterId: event.clusterId,
      scope: 'pod',
      namespace,
      pod,
      podUid,
    });
  if (workload && namespace)
    result.push({
      clusterId: event.clusterId,
      scope: 'deployment',
      namespace,
      workload,
    });
  if (node) result.push({ clusterId: event.clusterId, scope: 'node', node });
  return result;
}

import {
  canonicalMetricName,
  metricNames,
  type MetricEvent,
  type TelemetryEvent,
} from '@faultline/telemetry';
import {
  cpuCores,
  memoryBytes,
  restartChange,
  utilizationPercent,
} from './calculations';
import type {
  ResourceIdentity,
  ResourceState,
  ResourceStateStore,
} from './resource-state';

type FieldValue = number | boolean | null | Record<string, unknown>;
interface Sample {
  value: FieldValue;
  timestamp: string;
  time: bigint;
  expiresAt: number;
}
interface Entry {
  identity: ResourceIdentity;
  fields: Map<string, Sample>;
}

function identityFor(event: MetricEvent): ResourceIdentity | undefined {
  const attribute = (key: string) =>
    typeof event.attributes[key] === 'string'
      ? (event.attributes[key] as string)
      : undefined;
  const name = canonicalMetricName(event.name);
  const scope = name.startsWith('k8s.container.')
    ? 'container'
    : name.startsWith('k8s.pod.')
      ? 'pod'
      : name.startsWith('k8s.deployment.')
        ? 'deployment'
        : name.startsWith('k8s.node.')
          ? 'node'
          : undefined;
  if (
    !scope ||
    ((scope === 'container' || scope === 'pod') &&
      (!event.namespace || !event.pod)) ||
    (scope === 'container' && !event.container) ||
    (scope === 'deployment' && (!event.namespace || !event.workload)) ||
    (scope === 'node' && !event.node)
  )
    return;
  return {
    clusterId: event.clusterId,
    scope,
    namespace: scope === 'node' ? undefined : event.namespace,
    pod: event.pod,
    podUid: attribute('k8s.pod.uid'),
    container: scope === 'container' ? event.container : undefined,
    workload: event.workload,
    workloadKind:
      attribute('k8s.deployment.name') === event.workload
        ? 'Deployment'
        : attribute('k8s.replicaset.name') === event.workload
          ? 'ReplicaSet'
          : undefined,
    workloadUid: attribute('k8s.deployment.uid'),
    node: event.node,
  };
}

function key(identity: ResourceIdentity): string {
  const name =
    identity.scope === 'node'
      ? identity.node
      : identity.scope === 'deployment'
        ? (identity.workloadUid ?? identity.workload)
        : (identity.podUid ?? identity.pod);
  return JSON.stringify([
    identity.clusterId,
    identity.scope,
    identity.namespace ?? '',
    name,
    identity.container ?? '',
  ]);
}

function fieldFor(
  event: MetricEvent,
): { field: string; value: FieldValue } | undefined {
  if (event.metricType !== 'gauge' || !Number.isFinite(event.value)) return;
  const name = canonicalMetricName(event.name);
  const numeric: Record<
    string,
    [string, (value: number, unit?: string) => number | undefined]
  > = {
    [metricNames.cpuUsage]: ['cpuUsage', cpuCores],
    [metricNames.cpuLimit]: ['cpuLimit', cpuCores],
    [metricNames.cpuRequest]: ['cpuRequest', cpuCores],
    [metricNames.memoryUsage]: ['memoryUsage', memoryBytes],
    [metricNames.memoryLimit]: ['memoryLimit', memoryBytes],
    [metricNames.memoryRequest]: ['memoryRequest', memoryBytes],
    'k8s.pod.cpu.usage': ['cpuUsage', cpuCores],
    'k8s.pod.memory.usage': ['memoryUsage', memoryBytes],
    'k8s.node.cpu.usage': ['cpuUsage', cpuCores],
    'k8s.node.memory.usage': ['memoryUsage', memoryBytes],
  };
  const mapping = numeric[name];
  if (mapping) {
    const value = mapping[1](event.value, event.unit);
    return value === undefined ? undefined : { field: mapping[0], value };
  }
  if (
    name === metricNames.containerReady ||
    name === metricNames.podReady ||
    name.startsWith('k8s.node.condition_')
  ) {
    if (![-1, 0, 1].includes(event.value)) return;
    if (
      name.startsWith('k8s.node.condition_') &&
      ![
        'ready',
        'memory_pressure',
        'disk_pressure',
        'pid_pressure',
        'network_unavailable',
      ].includes(name.slice('k8s.node.condition_'.length))
    )
      return;
    return {
      field: name.startsWith('k8s.node.condition_')
        ? 'condition:' + name.slice('k8s.node.condition_'.length)
        : 'ready',
      value: event.value === -1 ? null : event.value === 1,
    };
  }
  if (name === metricNames.containerState) {
    const state = event.attributes.state;
    if (
      event.value !== 1 ||
      typeof state !== 'string' ||
      !['running', 'waiting', 'terminated', 'unknown'].includes(state)
    )
      return;
    return {
      field: 'containerStatus',
      value: {
        containerState: state,
        containerStateReason:
          typeof event.attributes.reason === 'string'
            ? event.attributes.reason
            : null,
        terminationReason:
          state === 'terminated' && typeof event.attributes.reason === 'string'
            ? event.attributes.reason
            : null,
        lastTerminationReason:
          typeof event.attributes.lastTerminationReason === 'string'
            ? event.attributes.lastTerminationReason
            : null,
      },
    };
  }
  const integers: Record<string, string> = {
    [metricNames.restartCount]: 'restart',
    [metricNames.podPhase]: 'podPhase',
    [metricNames.deploymentDesired]: 'desiredReplicas',
    [metricNames.deploymentAvailable]: 'availableReplicas',
    [metricNames.deploymentUnavailable]: 'unavailableReplicas',
  };
  if (
    integers[name] &&
    Number.isSafeInteger(event.value) &&
    event.value >= 0 &&
    (name !== metricNames.podPhase || (event.value >= 1 && event.value <= 5))
  ) {
    return { field: integers[name]!, value: event.value };
  }
  return;
}

/** Bounded process-local cache, independently expiring fields, no persistence or anomaly rules. */
export class InMemoryResourceState implements ResourceStateStore {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly ttlMs = 120_000,
    private readonly capacity = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isSafeInteger(capacity) ||
      capacity <= 0
    )
      throw new Error('Invalid resource-state bounds');
  }

  sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      for (const [field, sample] of entry.fields)
        if (sample.expiresAt <= now) entry.fields.delete(field);
      if (!entry.fields.size) this.entries.delete(id);
    }
  }

  update(event: MetricEvent): ResourceState | undefined {
    const identity = identityFor(event);
    if (!identity) return;
    const mapped = fieldFor(event);
    const millis = Date.parse(event.timestamp);
    const now = this.now();
    if (
      !identity ||
      !mapped ||
      !Number.isFinite(millis) ||
      millis <= now - this.ttlMs ||
      millis > now + 60_000
    )
      return;
    // Preserve OTLP sub-millisecond ordering while accepting timezone offsets.
    const fraction = /\.(\d+)/.exec(event.timestamp)?.[1] ?? '';
    const time =
      BigInt(millis) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(3, 9));
    this.sweep();
    const id = key(identity);
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= this.capacity)
        this.entries.delete(this.entries.keys().next().value!);
      entry = { identity, fields: new Map() };
      this.entries.set(id, entry);
    }
    const previous = entry.fields.get(mapped.field);
    if (previous && time <= previous.time) return; // Equal timestamps are idempotent, first sample wins.
    const value =
      mapped.field === 'restart'
        ? restartChange(
            previous
              ? (previous.value as Record<string, number>).restartCount
              : undefined,
            mapped.value as number,
          )
        : mapped.value;
    entry.fields.set(mapped.field, {
      value,
      timestamp: event.timestamp,
      time,
      expiresAt: Math.min(now + this.ttlMs, millis + this.ttlMs),
    });
    // Preserve enrichment missing from the snapshot source. Identity key never changes.
    for (const [field, value] of Object.entries(identity))
      if (value !== undefined)
        Object.assign(entry.identity, { [field]: value });
    this.entries.delete(id);
    this.entries.set(id, entry); // LRU capacity eviction.
    return this.snapshot(entry);
  }

  get(identity: ResourceIdentity): ResourceState | undefined {
    this.sweep();
    const entry = this.entries.get(key(identity));
    return entry ? this.snapshot(entry) : undefined;
  }

  findForTelemetry(event: TelemetryEvent): ResourceState | undefined {
    this.sweep();
    const podUid =
      (typeof event.attributes['k8s.pod.uid'] === 'string'
        ? event.attributes['k8s.pod.uid']
        : undefined) ??
      (event.kind === 'kubernetes' && event.involvedObject.kind === 'Pod'
        ? event.involvedObject.uid
        : undefined);
    const namespace =
      event.namespace ??
      (event.kind === 'kubernetes'
        ? event.involvedObject.namespace
        : undefined);
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
    const candidates: ResourceIdentity[] = [];
    if (pod && namespace && event.container)
      candidates.push({
        clusterId: event.clusterId,
        scope: 'container',
        namespace,
        pod,
        podUid,
        container: event.container,
      });
    if (pod && namespace)
      candidates.push({
        clusterId: event.clusterId,
        scope: 'pod',
        namespace,
        pod,
        podUid,
      });
    if (workload && namespace)
      candidates.push({
        clusterId: event.clusterId,
        scope: 'deployment',
        namespace,
        workload,
      });
    if (node)
      candidates.push({ clusterId: event.clusterId, scope: 'node', node });
    for (const candidate of candidates) {
      const entry = this.entries.get(key(candidate));
      if (entry) return this.snapshot(entry);
    }
    return undefined;
  }

  private snapshot(entry: Entry): ResourceState {
    const values: Record<string, unknown> = {};
    const fieldTimestamps: Record<string, string> = {};
    let latest: Sample | undefined;
    for (const [field, sample] of entry.fields) {
      fieldTimestamps[field] = sample.timestamp;
      if (!latest || sample.time > latest.time) latest = sample;
      if (field === 'restart' || field === 'containerStatus')
        Object.assign(values, sample.value);
      else if (field.startsWith('condition:')) {
        const conditions = (values.nodeConditions ??= {}) as Record<
          string,
          unknown
        >;
        conditions[field.slice(10)] = sample.value;
      } else values[field] = sample.value;
    }
    return structuredClone({
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
    }) as ResourceState;
  }
}

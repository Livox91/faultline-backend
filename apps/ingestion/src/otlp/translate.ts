import { randomUUID } from 'node:crypto';
import {
  telemetryEventSchema,
  normalizeWorkloadSnapshot,
  type TelemetryEvent,
} from '@faultline/telemetry';

// Wire decoding only: all normalized events use the existing shared runtime contract.
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return value as ObjectValue;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function anyValue(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error('OTLP value nesting exceeded');
  const entry = object(value);
  if (Object.keys(entry).length === 0) return null;
  if (Object.keys(entry).length !== 1) throw new Error('Invalid OTLP AnyValue');
  if (typeof entry.stringValue === 'string') return entry.stringValue;
  if (typeof entry.boolValue === 'boolean') return entry.boolValue;
  if (
    typeof entry.doubleValue === 'number' &&
    Number.isFinite(entry.doubleValue)
  )
    return entry.doubleValue;
  if (
    typeof entry.intValue === 'string' &&
    /^-?\d{1,19}$/.test(entry.intValue)
  ) {
    const integer = BigInt(entry.intValue);
    if (integer < -(2n ** 63n) || integer >= 2n ** 63n)
      throw new Error('Invalid int64');
    return Number.isSafeInteger(Number(integer))
      ? Number(integer)
      : entry.intValue;
  }
  if (
    typeof entry.intValue === 'number' &&
    Number.isSafeInteger(entry.intValue)
  )
    return entry.intValue;
  if (
    typeof entry.bytesValue === 'string' &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      entry.bytesValue,
    )
  )
    return entry.bytesValue;
  if (entry.arrayValue)
    return array(object(entry.arrayValue).values ?? []).map((item) =>
      anyValue(item, depth + 1),
    );
  if (entry.kvlistValue)
    return attributes(object(entry.kvlistValue).values, depth + 1);
  throw new Error('Invalid OTLP AnyValue');
}
export function attributes(value: unknown, depth = 0): ObjectValue {
  const entries = array(value ?? []);
  if (entries.length > 1024) throw new Error('Too many attributes');
  return Object.fromEntries(
    entries.map((item) => {
      const entry = object(item);
      if (typeof entry.key !== 'string')
        throw new Error('Invalid attribute key');
      return [entry.key, anyValue(entry.value, depth)];
    }),
  );
}
export function nanos(value: unknown): string | undefined {
  if (value === undefined || value === '0' || value === 0) return undefined;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value))
    throw new Error('Invalid timestamp');
  const integer = BigInt(value);
  if (integer > 2n ** 64n - 1n) throw new Error('Invalid timestamp');
  return (
    new Date(Number(integer / 1000000000n) * 1000).toISOString().slice(0, 19) +
    '.' +
    (integer % 1000000000n).toString().padStart(9, '0') +
    'Z'
  );
}
function severity(record: ObjectValue): string {
  const number = record.severityNumber ?? 0;
  if (!Number.isInteger(number) || Number(number) < 0 || Number(number) > 24)
    throw new Error('Invalid severity');
  if (Number(number) > 0)
    return ['trace', 'debug', 'info', 'warn', 'error', 'fatal'][
      Math.floor((Number(number) - 1) / 4)
    ]!;
  const label = text(record.severityText)?.toLowerCase();
  if (label === 'warning') return 'warn';
  return label &&
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(label)
    ? label
    : 'unknown';
}

function translate(
  recordValue: unknown,
  resource: ObjectValue,
  scope: ObjectValue,
  clusterId: string,
): TelemetryEvent | TelemetryEvent[] {
  const record = object(recordValue);
  const attrs = attributes(record.attributes);
  if (
    resource['faultline.cluster.id'] !== undefined &&
    resource['faultline.cluster.id'] !== clusterId
  )
    throw new Error('Cluster mismatch');
  for (const key of [
    'k8s.namespace.name',
    'k8s.pod.name',
    'k8s.pod.uid',
    'k8s.container.name',
    'container.id',
    'k8s.node.name',
    'service.name',
    'k8s.deployment.name',
    'k8s.statefulset.name',
    'k8s.daemonset.name',
    'k8s.job.name',
    'k8s.replicaset.name',
  ]) {
    if (
      resource[key] !== undefined &&
      (typeof resource[key] !== 'string' || !resource[key].trim())
    )
      throw new Error('Invalid Kubernetes metadata');
  }
  const eventTime = nanos(record.timeUnixNano);
  const observedTime = nanos(record.observedTimeUnixNano);
  const timestamp = eventTime ?? observedTime;
  if (!timestamp) throw new Error('Missing telemetry timestamp');
  if (
    record.severityText !== undefined &&
    typeof record.severityText !== 'string'
  )
    throw new Error('Invalid severity text');
  const body = anyValue(record.body ?? {});
  const common = {
    id: randomUUID(),
    clusterId,
    timestamp,
    ingestedAt: new Date().toISOString(),
    namespace: text(resource['k8s.namespace.name']),
    pod: text(resource['k8s.pod.name']),
    container: text(resource['k8s.container.name']),
    node: text(resource['k8s.node.name']),
    service:
      text(resource['service.name']) ??
      text(resource['k8s.pod.label.app.kubernetes.io/name']),
    workload: [
      'k8s.deployment.name',
      'k8s.statefulset.name',
      'k8s.daemonset.name',
      'k8s.job.name',
      'k8s.replicaset.name',
    ]
      .map((key) => text(resource[key]))
      .find(Boolean),
    attributes: {
      ...resource,
      ...attrs,
      'otel.scope': scope,
      'otel.severity_text': record.severityText ?? '',
      'otel.severity_number': record.severityNumber ?? 0,
      'otel.observed_time_unix_nano': record.observedTimeUnixNano ?? '0',
      'otel.time_unix_nano': record.timeUnixNano ?? '0',
    },
    raw: body,
  };
  if (resource['faultline.source'] === 'kubernetes-state') {
    const wrapped = object(body);
    return normalizeWorkloadSnapshot(
      wrapped.object ?? wrapped,
      {
        clusterId,
        timestamp,
        ingestedAt: common.ingestedAt,
      },
      randomUUID,
    );
  }
  if (
    resource['faultline.source'] === 'kubernetes-events' ||
    scope.name ===
      'github.com/open-telemetry/opentelemetry-collector-contrib/receiver/k8sobjectsreceiver'
  ) {
    const wrapped = object(body);
    const event = object(wrapped.object ?? wrapped);
    if (event.kind !== 'Event')
      throw new Error('Unsupported Kubernetes object');
    const involved = object(event.involvedObject ?? event.regarding);
    const metadata = object(event.metadata ?? {});
    const series = object(event.series ?? {});
    const source = object(event.source ?? {});
    // Use the event's own occurrence time; collector observation remains in attributes.
    const eventTimestamp =
      text(event.lastTimestamp) ??
      text(series.lastObservedTime) ??
      text(event.eventTime) ??
      text(event.firstTimestamp) ??
      text(metadata.creationTimestamp) ??
      timestamp;
    return telemetryEventSchema.parse({
      ...common,
      timestamp: eventTimestamp,
      kind: 'kubernetes',
      type: event.type,
      reason: event.reason,
      message: event.message ?? event.note,
      namespace:
        text(involved.namespace) ??
        text(metadata.namespace) ??
        common.namespace,
      pod: involved.kind === 'Pod' ? text(involved.name) : common.pod,
      node: text(source.host) ?? common.node,
      involvedObject: {
        ...involved,
        clusterId,
        apiVersion: involved.apiVersion ?? 'v1',
      },
      count: event.count ?? series.count ?? event.deprecatedCount,
      attributes: {
        ...common.attributes,
        ...(involved.kind === 'Pod' && text(involved.uid)
          ? { 'k8s.pod.uid': involved.uid }
          : {}),
      },
    });
  }
  const stream = attrs['log.iostream'] ?? attrs.stream;
  return telemetryEventSchema.parse({
    ...common,
    kind: 'log',
    message: typeof body === 'string' ? body : JSON.stringify(body),
    level: severity(record),
    stream,
  });
}

export function translateOtlpLogs(
  body: unknown,
  clusterId: string,
): { events: TelemetryEvent[]; rejected: number } {
  const request = object(body);
  const resources = array(request.resourceLogs ?? []);
  const pending: {
    record: unknown;
    resource: ObjectValue;
    scope: ObjectValue;
  }[] = [];
  for (const value of resources) {
    const group = object(value);
    const resource = attributes(object(group.resource ?? {}).attributes);
    for (const scopeValue of array(group.scopeLogs ?? [])) {
      const scoped = object(scopeValue);
      const scope = object(scoped.scope ?? {});
      for (const record of array(scoped.logRecords ?? [])) {
        pending.push({ record, resource, scope });
        if (pending.length > 256)
          throw new Error('OTLP batch exceeds 256 records');
      }
    }
  }
  const events: TelemetryEvent[] = [];
  let rejected = 0;
  for (const item of pending) {
    try {
      const translated = translate(
        item.record,
        item.resource,
        item.scope,
        clusterId,
      );
      events.push(...(Array.isArray(translated) ? translated : [translated]));
    } catch {
      rejected++;
    }
  }
  if (events.length > 4096)
    throw new Error('Expanded batch exceeds 4096 events');
  return { events, rejected };
}

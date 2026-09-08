import { randomUUID } from 'node:crypto';
import {
  metricEventSchema,
  canonicalMetricName,
  canonicalMetricUnit,
  metricCategory,
  type MetricEvent,
} from '@faultline/telemetry';
import { object, array, attributes, nanos, text } from './translate';

/** Scalar OTLP gauge/sum points only; unsupported histogram/summary points are rejected explicitly. */
export function translateOtlpMetrics(
  body: unknown,
  clusterId: string,
): {
  events: MetricEvent[];
  rejected: number;
} {
  const request = object(body);
  const events: MetricEvent[] = [];
  let rejected = 0;
  let count = 0;
  for (const resourceValue of array(request.resourceMetrics ?? [])) {
    const group = object(resourceValue);
    const resource = attributes(object(group.resource ?? {}).attributes);
    for (const scopeValue of array(group.scopeMetrics ?? [])) {
      const scoped = object(scopeValue);
      const scope = object(scoped.scope ?? {});
      for (const metricValue of array(scoped.metrics ?? [])) {
        const metric = object(metricValue);
        const types = [
          'gauge',
          'sum',
          'histogram',
          'exponentialHistogram',
          'summary',
        ].filter((key) => metric[key] !== undefined);
        if (types.length !== 1)
          throw new Error('Metric requires exactly one data type');
        const type = types[0]!;
        const data = object(metric[type]);
        for (const pointValue of array(data.dataPoints ?? [])) {
          if (++count > 256) throw new Error('OTLP batch exceeds 256 points');
          try {
            if (type !== 'gauge' && type !== 'sum')
              throw new Error('Unsupported metric type');
            if (
              type === 'sum' &&
              ![
                1,
                2,
                'AGGREGATION_TEMPORALITY_DELTA',
                'AGGREGATION_TEMPORALITY_CUMULATIVE',
              ].includes(data.aggregationTemporality as number)
            )
              throw new Error('Invalid sum temporality');
            if (
              data.isMonotonic !== undefined &&
              typeof data.isMonotonic !== 'boolean'
            )
              throw new Error('Invalid monotonic flag');
            if (
              resource['faultline.cluster.id'] !== undefined &&
              resource['faultline.cluster.id'] !== clusterId
            )
              throw new Error('Cluster mismatch');
            const point = object(pointValue);
            if (
              point.flags !== undefined &&
              (!Number.isInteger(point.flags) ||
                Number(point.flags) < 0 ||
                Number(point.flags) > 1)
            )
              throw new Error('Invalid point flags');
            if (point.flags === 1) {
              rejected++;
              continue;
            } // NO_RECORDED_VALUE
            if ((point.asDouble === undefined) === (point.asInt === undefined))
              throw new Error('Expected one scalar');
            let value: number;
            if (point.asInt !== undefined) {
              if (
                typeof point.asInt !== 'string' ||
                !/^-?\d{1,19}$/.test(point.asInt)
              )
                throw new Error('Invalid integer');
              value = Number(point.asInt);
              if (!Number.isSafeInteger(value))
                throw new Error('Integer precision loss');
            } else {
              if (
                typeof point.asDouble !== 'number' ||
                !Number.isFinite(point.asDouble)
              )
                throw new Error('Invalid double');
              value = point.asDouble;
            }
            const timestamp = nanos(point.timeUnixNano);
            if (
              !timestamp ||
              typeof metric.name !== 'string' ||
              !metric.name.trim()
            )
              throw new Error('Missing metric identity');
            const pointAttrs = attributes(point.attributes);
            // Resource identity is authoritative; points cannot change the resource's identity.
            const identity = (key: string) => {
              const candidate = resource[key];
              if (
                candidate !== undefined &&
                (typeof candidate !== 'string' || !candidate.trim())
              )
                throw new Error('Invalid metadata');
              return text(candidate);
            };
            const name = canonicalMetricName(metric.name);
            for (const key of [
              'k8s.pod.uid',
              'k8s.deployment.uid',
              'container.id',
            ])
              identity(key);
            if (metric.unit !== undefined && typeof metric.unit !== 'string')
              throw new Error('Invalid unit');
            const monotonic = type === 'sum' && data.isMonotonic === true;
            events.push(
              metricEventSchema.parse({
                id: randomUUID(),
                kind: 'metric',
                clusterId,
                timestamp,
                ingestedAt: new Date().toISOString(),
                namespace: identity('k8s.namespace.name'),
                pod: identity('k8s.pod.name'),
                container: identity('k8s.container.name'),
                node: identity('k8s.node.name'),
                service: identity('service.name'),
                workload:
                  identity('k8s.deployment.name') ??
                  identity('k8s.statefulset.name') ??
                  identity('k8s.daemonset.name') ??
                  identity('k8s.replicaset.name'),
                name,
                value,
                unit: canonicalMetricUnit(
                  (metric.unit as string | undefined) ?? '',
                ),
                metricType: monotonic ? 'counter' : 'gauge',
                category: metricCategory(name),
                attributes: {
                  ...pointAttrs,
                  ...resource,
                  'otel.scope': scope,
                  'otel.metric.name': metric.name,
                  ...(type === 'sum'
                    ? {
                        'otel.aggregation_temporality':
                          data.aggregationTemporality,
                        'otel.is_monotonic': data.isMonotonic ?? false,
                      }
                    : {}),
                  ...(point.startTimeUnixNano
                    ? {
                        'otel.start_time':
                          nanos(point.startTimeUnixNano) ?? timestamp,
                      }
                    : {}),
                },
                raw: {
                  name: metric.name,
                  unit: metric.unit ?? '',
                  point: pointValue,
                },
              }),
            );
          } catch {
            rejected++;
          }
        }
      }
    }
  }
  return { events, rejected };
}

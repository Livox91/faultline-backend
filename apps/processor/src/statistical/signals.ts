import {
  baselineMetricDefinitions,
  latencyMetricNames,
  percentile,
  summarize,
  type BaselineMetricDefinition,
} from '@faultline/baselines';
import type { AnomalyAffectedResource } from '@faultline/incidents';
import type { TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';
import { resourceFromEvent, resourceFromState } from '../rules/helpers';

/**
 * Live-telemetry side of statistical detection.
 *
 * The baseline says what a workload normally does; this module produces the comparable
 * "right now" number. The two must be computed the same way or the comparison is
 * meaningless, so a counter baselined as bytes-per-second is also read here as
 * bytes-per-second, and an error rate baselined as a percentage of logs is read the same
 * way from the live stream.
 */

/** A single observation contributed by one telemetry event. */
export interface SignalSample {
  timestamp: number;
  value: number;
}

export type SignalValueKind = 'gauge' | 'counter' | 'indicator';

export interface SignalContribution {
  /** Baseline metric id this sample belongs to. */
  metricId: string;
  resource: AnomalyAffectedResource;
  sample: SignalSample;
  kind: SignalValueKind;
}

const latencyMetrics: ReadonlySet<string> = new Set(latencyMetricNames);

/**
 * Maps one telemetry event onto the signals it feeds.
 *
 * Returning several contributions from one event is normal: a memory sample updates both
 * the raw-usage signal and, when the container's limit is known, the utilization signal.
 */
export function contributionsFor(
  event: TelemetryEvent,
  state?: ResourceState,
): readonly SignalContribution[] {
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return [];
  const resource = state ? resourceFromState(state) : resourceFromEvent(event);

  if (event.kind === 'log') {
    // Every log is a 0/1 observation of "was this an error". Averaging that indicator
    // over the window yields exactly the error ratio the baseline stores.
    const isError = event.level === 'error' || event.level === 'fatal';
    return [
      {
        metricId: 'faultline.workload.log_error_rate',
        resource: workloadScoped(resource),
        sample: { timestamp, value: isError ? 1 : 0 },
        kind: 'indicator',
      },
    ];
  }

  if (event.kind !== 'metric') return [];
  const contributions: SignalContribution[] = [];

  if (event.name === 'k8s.container.memory.usage') {
    contributions.push({
      metricId: 'k8s.container.memory.usage',
      resource,
      sample: { timestamp, value: event.value },
      kind: 'gauge',
    });
    // Utilization is only meaningful when a limit is configured. Resource state already
    // resolved usage against limit, so it is read from there rather than recomputed.
    if (state?.memoryUtilizationPercent !== undefined)
      contributions.push({
        metricId: 'faultline.container.memory.utilization',
        resource,
        sample: { timestamp, value: state.memoryUtilizationPercent },
        kind: 'gauge',
      });
    return contributions;
  }

  if (event.name === 'k8s.container.cpu.usage')
    return [
      {
        metricId: 'k8s.container.cpu.usage',
        resource,
        sample: { timestamp, value: event.value },
        kind: 'gauge',
      },
    ];

  if (event.name === 'k8s.container.restart_count')
    return [
      {
        metricId: 'faultline.container.restart_rate',
        resource,
        sample: { timestamp, value: event.value },
        kind: 'counter',
      },
    ];

  if (event.name === 'k8s.pod.network.io') {
    const direction = event.attributes.direction;
    if (direction !== 'receive' && direction !== 'transmit') return [];
    return [
      {
        metricId:
          direction === 'receive'
            ? 'faultline.pod.network.receive_rate'
            : 'faultline.pod.network.transmit_rate',
        resource: podScoped(resource),
        sample: { timestamp, value: event.value },
        kind: 'counter',
      },
    ];
  }

  // Latency is only ever read from a real latency metric. Nothing is inferred from logs.
  if (latencyMetrics.has(event.name))
    return [
      {
        metricId: event.name,
        resource: workloadScoped(resource),
        sample: { timestamp, value: event.value },
        kind: 'gauge',
      },
    ];

  return [];
}

/** Error rate and latency describe the service, not one replica's container. */
function workloadScoped(
  resource: AnomalyAffectedResource,
): AnomalyAffectedResource {
  if (resource.scope !== 'container') return resource;
  const { container: _container, ...rest } = resource;
  return { ...rest, scope: 'pod' };
}

/** Network counters are reported per pod by kubelet, never per container. */
function podScoped(
  resource: AnomalyAffectedResource,
): AnomalyAffectedResource {
  return workloadScoped(resource);
}

export interface CurrentObservation {
  value: number;
  sampleCount: number;
  windowMs: number;
  /** Populated for percentile comparisons. */
  p95?: number;
  p50?: number;
}

/**
 * Collapses a window of live samples into one number comparable with the baseline.
 *
 * Gauges use the rolling mean rather than the newest sample: a single spike should not
 * open an anomaly, and averaging is the cheapest honest way to say so. Counters become
 * rates, and indicators become the ratio they were counting.
 */
export function currentObservation(
  samples: readonly SignalSample[],
  definition: BaselineMetricDefinition,
): CurrentObservation | undefined {
  if (samples.length < 2) return undefined;
  const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const windowMs = ordered.at(-1)!.timestamp - ordered[0]!.timestamp;

  if (definition.source.kind === 'counter-rate') {
    const rate = counterRateFromSamples(ordered, definition.source.perSeconds);
    if (rate === undefined) return undefined;
    return { value: rate, sampleCount: ordered.length, windowMs };
  }

  const values = ordered.map((sample) => sample.value);
  if (definition.source.kind === 'log-error-rate') {
    const errors = values.reduce((sum, value) => sum + value, 0);
    return {
      value: (errors / values.length) * definition.source.scale,
      sampleCount: ordered.length,
      windowMs,
    };
  }

  const statistics = summarize(values);
  if (!statistics) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    value: statistics.mean,
    sampleCount: ordered.length,
    windowMs,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

/**
 * Rate from a monotonic counter, tolerant of resets.
 *
 * Deltas are summed pairwise rather than taken end-to-end so that a container restarting
 * mid-window - which sends the counter back to zero - contributes the work it actually
 * did instead of a large negative number.
 */
export function counterRateFromSamples(
  ordered: readonly SignalSample[],
  perSeconds: number,
): number | undefined {
  if (ordered.length < 2) return undefined;
  const spanMs = ordered.at(-1)!.timestamp - ordered[0]!.timestamp;
  if (spanMs <= 0) return undefined;
  let total = 0;
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!.value;
    const current = ordered[index]!.value;
    total += current >= previous ? current - previous : Math.max(0, current);
  }
  return (total / spanMs) * 1000 * perSeconds;
}

const definitionsById = new Map(
  baselineMetricDefinitions.map((definition) => [definition.id, definition]),
);

export function definitionFor(
  metricId: string,
): BaselineMetricDefinition | undefined {
  return definitionsById.get(metricId);
}

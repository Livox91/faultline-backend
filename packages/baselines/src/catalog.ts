import type { AnomalyClassification } from '@faultline/incidents';
import type { BaselineResourceType, BaselineWindow } from './baseline';

/**
 * The metrics Faultline baselines, and how each one is read and compared.
 *
 * The catalog is the single place that answers "which signals exist, where do their
 * samples come from, and which statistical technique suits them". The refresh job walks
 * it to build baselines; the detector walks the same list to compare live telemetry.
 * Keeping both on one definition is what stops the two halves from drifting apart.
 */

/** Statistical classifications. Deterministic rules keep their own vocabulary. */
export const statisticalClassifications = [
  'CPU_USAGE_ANOMALY',
  'MEMORY_USAGE_ANOMALY',
  'MEMORY_GROWTH_ANOMALY',
  'ERROR_RATE_ANOMALY',
  'RESTART_RATE_ANOMALY',
  'NETWORK_RX_ANOMALY',
  'NETWORK_TX_ANOMALY',
  'LATENCY_ANOMALY',
] as const;

export type StatisticalClassification =
  (typeof statisticalClassifications)[number];

// Compile-time proof that every statistical classification is a shared anomaly
// classification: the two must never diverge.
const _classificationsAreShared: readonly AnomalyClassification[] =
  statisticalClassifications;
void _classificationsAreShared;

export interface MetricSelector {
  metricName: string;
  /** Attribute equality filters, e.g. `{ direction: 'receive' }` on network counters. */
  attributes?: Readonly<Record<string, string>>;
}

/**
 * How a signal's samples are derived from stored telemetry.
 *
 * Counters and ratios are computed per bucket first, then summarized, so a baseline is
 * always a distribution of comparable per-bucket values rather than a mix of raw
 * counter readings.
 */
export type BaselineMetricSource =
  | ({ kind: 'gauge' } & MetricSelector)
  | ({
      kind: 'counter-rate';
      /** Seconds the rate is expressed over: 1 for bytes/s, 3600 for restarts/hour. */
      perSeconds: number;
    } & MetricSelector)
  | {
      kind: 'ratio';
      numerator: MetricSelector;
      denominator: MetricSelector;
      /** 100 turns a fraction into a percentage. */
      scale: number;
    }
  | {
      kind: 'log-error-rate';
      severities: readonly string[];
      scale: number;
    };

export type DetectionTechnique = 'z-score' | 'percentile' | 'trend';

export interface DetectionSpec {
  classification: StatisticalClassification;
  technique: DetectionTechnique;
  /** Reference percentile for the `percentile` technique. */
  percentile?: 'p95' | 'p99';
  /**
   * Detecting only increases is deliberate for most signals: memory dropping back or
   * traffic going quiet is rarely the operator's problem, and alerting on it doubles
   * the noise for no diagnostic gain. Network is `both` because a collapse in traffic
   * is itself a symptom worth surfacing.
   */
  direction: 'above' | 'both';
}

export type BaselineWindowChoice = 'default' | 'fast';

export interface BaselineMetricDefinition {
  /** Stable identifier stored on the baseline row and shown by the baselines API. */
  id: string;
  label: string;
  unit?: string;
  resourceType: BaselineResourceType;
  window: BaselineWindowChoice;
  source: BaselineMetricSource;
  detections: readonly DetectionSpec[];
  /**
   * Values below this are ignored when comparing. A workload idling at 2 millicores can
   * triple without meaning anything, and floors like this remove most of that noise.
   */
  minimumMeaningfulValue?: number;
}

/**
 * Latency metric names Faultline recognizes.
 *
 * Nothing here is inferred from logs. If an application or proxy does not export one of
 * these, no latency baseline exists and no latency anomaly can be raised - which is the
 * required behaviour, not a gap.
 */
export const latencyMetricNames = [
  'http.server.duration',
  'request.duration',
  'api.latency',
] as const;

function latencyDefinition(metricName: string): BaselineMetricDefinition {
  return {
    id: metricName,
    label: 'Request latency',
    unit: 'ms',
    resourceType: 'workload',
    window: 'fast',
    source: { kind: 'gauge', metricName },
    // Latency distributions are long-tailed, so comparing percentiles is far more
    // meaningful than comparing means: a p95 that triples is visible to users even when
    // the average barely moves.
    detections: [
      {
        classification: 'LATENCY_ANOMALY',
        technique: 'percentile',
        percentile: 'p95',
        direction: 'above',
      },
    ],
  };
}

export const baselineMetricDefinitions: readonly BaselineMetricDefinition[] = [
  {
    id: 'k8s.container.cpu.usage',
    label: 'CPU usage',
    unit: 'cores',
    resourceType: 'container',
    window: 'fast',
    source: { kind: 'gauge', metricName: 'k8s.container.cpu.usage' },
    detections: [
      {
        classification: 'CPU_USAGE_ANOMALY',
        technique: 'z-score',
        direction: 'above',
      },
    ],
    minimumMeaningfulValue: 0.01,
  },
  {
    id: 'k8s.container.memory.usage',
    label: 'Memory usage',
    unit: 'By',
    resourceType: 'container',
    window: 'default',
    source: { kind: 'gauge', metricName: 'k8s.container.memory.usage' },
    // One baseline, two questions: is memory unusually high right now, and is it
    // climbing steadily? The second is what catches a leak long before the first does.
    detections: [
      {
        classification: 'MEMORY_USAGE_ANOMALY',
        technique: 'z-score',
        direction: 'above',
      },
      {
        classification: 'MEMORY_GROWTH_ANOMALY',
        technique: 'trend',
        direction: 'above',
      },
    ],
    minimumMeaningfulValue: 1024 * 1024,
  },
  {
    id: 'faultline.container.memory.utilization',
    label: 'Memory utilization',
    unit: '%',
    resourceType: 'container',
    window: 'default',
    source: {
      kind: 'ratio',
      numerator: { metricName: 'k8s.container.memory.usage' },
      denominator: { metricName: 'k8s.container.memory.limit' },
      scale: 100,
    },
    detections: [
      {
        classification: 'MEMORY_USAGE_ANOMALY',
        technique: 'z-score',
        direction: 'above',
      },
    ],
    minimumMeaningfulValue: 1,
  },
  {
    id: 'faultline.container.restart_rate',
    label: 'Restart rate',
    unit: 'restarts/hour',
    resourceType: 'container',
    window: 'default',
    source: {
      kind: 'counter-rate',
      metricName: 'k8s.container.restart_count',
      perSeconds: 3600,
    },
    detections: [
      {
        classification: 'RESTART_RATE_ANOMALY',
        technique: 'z-score',
        direction: 'above',
      },
    ],
  },
  {
    id: 'faultline.pod.network.receive_rate',
    label: 'Network receive rate',
    unit: 'By/s',
    resourceType: 'pod',
    window: 'fast',
    source: {
      kind: 'counter-rate',
      metricName: 'k8s.pod.network.io',
      attributes: { direction: 'receive' },
      perSeconds: 1,
    },
    detections: [
      {
        classification: 'NETWORK_RX_ANOMALY',
        technique: 'z-score',
        direction: 'both',
      },
    ],
    minimumMeaningfulValue: 1024,
  },
  {
    id: 'faultline.pod.network.transmit_rate',
    label: 'Network transmit rate',
    unit: 'By/s',
    resourceType: 'pod',
    window: 'fast',
    source: {
      kind: 'counter-rate',
      metricName: 'k8s.pod.network.io',
      attributes: { direction: 'transmit' },
      perSeconds: 1,
    },
    detections: [
      {
        classification: 'NETWORK_TX_ANOMALY',
        technique: 'z-score',
        direction: 'both',
      },
    ],
    minimumMeaningfulValue: 1024,
  },
  {
    id: 'faultline.workload.log_error_rate',
    label: 'Log error rate',
    unit: '%',
    resourceType: 'workload',
    window: 'fast',
    // Derived from structured log severity only. This is an operational signal: a high
    // error-log rate says the workload is behaving unusually, not that users are failing.
    source: {
      kind: 'log-error-rate',
      severities: ['error', 'fatal'],
      scale: 100,
    },
    detections: [
      {
        classification: 'ERROR_RATE_ANOMALY',
        technique: 'z-score',
        direction: 'above',
      },
    ],
  },
  ...latencyMetricNames.map(latencyDefinition),
];

export function findBaselineMetric(
  id: string,
): BaselineMetricDefinition | undefined {
  return baselineMetricDefinitions.find((definition) => definition.id === id);
}

export interface BaselineWindowSettings {
  default: BaselineWindow;
  fast: BaselineWindow;
}

export function windowFor(
  definition: BaselineMetricDefinition,
  windows: BaselineWindowSettings,
): BaselineWindow {
  return windows[definition.window];
}

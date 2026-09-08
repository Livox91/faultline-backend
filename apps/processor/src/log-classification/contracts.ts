import type {
  LogClassificationResult,
  LogPatternAggregate,
} from '@faultline/log-classification';
import type { Anomaly } from '@faultline/incidents';
import type { LogEvent } from '@faultline/telemetry';

export const LOG_CLASSIFIER = Symbol('faultline.log-classifier');

export interface LogClassificationOutcome {
  result: LogClassificationResult;
  aggregate: LogPatternAggregate;
  anomaly?: Anomaly;
}

/** Peer to deterministic and statistical detection; only accepts normalized logs. */
export interface LogClassifier {
  classify(event: LogEvent): Promise<LogClassificationOutcome>;
}

export interface LogClassifierConfig {
  enabled: boolean;
  minimumConfidence: number;
  highConfidence: number;
  aggregationWindowMs: number;
}

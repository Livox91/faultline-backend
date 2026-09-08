import type {
  Anomaly,
  AnomalyAffectedResource,
  AnomalyClassification,
  AnomalyEvidence,
  AnomalySeverity,
} from '@faultline/incidents';
import type { AnomalyThresholds } from '@faultline/platform';
import type { TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';

export const RULE_ENGINE = Symbol('faultline.rule-engine');

export interface ConditionObservation {
  count: number;
  durationMs: number;
}

export interface RuleContext {
  event: TelemetryEvent;
  state?: ResourceState;
  thresholds: AnomalyThresholds;
  observe(key: string, condition: boolean): ConditionObservation;
  recentEvidence(
    predicate: (event: TelemetryEvent) => boolean,
  ): readonly TelemetryEvent[];
  restartIncreaseCount(resource: AnomalyAffectedResource): number;
}

export interface RuleMatch {
  severity: AnomalySeverity;
  confidence: number;
  summary: string;
  evidence: readonly AnomalyEvidence[];
}

export interface RuleEvaluation {
  dedupeKey: string;
  affectedResource: AnomalyAffectedResource;
  match: RuleMatch | null;
}

export interface AnomalyRule {
  readonly ruleId: string;
  readonly classification: AnomalyClassification;
  evaluate(context: RuleContext): readonly RuleEvaluation[];
}

export interface RuleEngine {
  evaluate(
    event: TelemetryEvent,
    state?: ResourceState,
  ): readonly Anomaly[] | Promise<readonly Anomaly[]>;
  commit?(): void | Promise<void>;
  rollback?(): void | Promise<void>;
}

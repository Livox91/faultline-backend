import type { LogEvent } from '@faultline/telemetry';

/** Stable, intentionally small taxonomy. Additive changes require a new version. */
export const LOG_CLASSIFICATION_TAXONOMY_VERSION = 'log-taxonomy-v1';
export const logClassifications = [
  'NORMAL',
  'APPLICATION_EXCEPTION',
  'DATABASE_CONNECTIVITY',
  'DEPENDENCY_TIMEOUT',
  'AUTHENTICATION_FAILURE',
  'AUTHORIZATION_FAILURE',
  'CONFIGURATION_ERROR',
  'NETWORK_FAILURE',
  'RATE_LIMITING',
  'RESOURCE_EXHAUSTION',
  'STORAGE_FAILURE',
  'STARTUP_FAILURE',
  'UNKNOWN',
] as const;

export type LogClassification = (typeof logClassifications)[number];
export type ActionableLogClassification = Exclude<
  LogClassification,
  'NORMAL' | 'UNKNOWN'
>;
export type LogClassifierType = 'RULE' | 'ML' | 'UNKNOWN';

export interface LogClassificationEvidence {
  summary: string;
  excerpt?: string;
  matchedPattern?: string;
}

/** A derived record. The normalized LogEvent remains immutable and lives in ClickHouse. */
export interface LogClassificationResult {
  eventId: string;
  classification: LogClassification;
  confidence: number;
  classifierType: LogClassifierType;
  /** Rule taxonomy version or immutable ML model version. */
  modelVersion: string;
  timestamp: string;
  patternId: string;
  evidence: readonly LogClassificationEvidence[];
}

export interface LogPatternAggregate {
  patternId: string;
  classification: LogClassification;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedPods: readonly string[];
}

export interface MlLogClassification {
  classification: LogClassification;
  confidence: number;
  modelVersion: string;
  evidence?: string;
}

/** Model-provider boundary. Node orchestration never imports a model library. */
export interface MachineLearningLogClassifier {
  classify(event: LogEvent): Promise<MlLogClassification>;
}

export interface LogClassificationRepository {
  save(
    result: LogClassificationResult,
    context: {
      clusterId: string;
      namespace?: string;
      workload?: string;
      pod?: string;
      aggregationWindowMs: number;
    },
  ): Promise<LogPatternAggregate>;
  get(eventId: string): Promise<LogClassificationResult | undefined>;
  getPattern(patternId: string): Promise<LogPatternAggregate | undefined>;
}

export const LOG_CLASSIFICATION_REPOSITORY = Symbol(
  'faultline.log-classification-repository',
);

/** Bounded development/test adapter; production uses PostgreSQL. */
export class InMemoryLogClassificationRepository implements LogClassificationRepository {
  private readonly results = new Map<string, LogClassificationResult>();
  private readonly patterns = new Map<string, LogPatternAggregate>();

  constructor(private readonly capacity = 10_000) {}

  async save(
    result: LogClassificationResult,
    context: { pod?: string; aggregationWindowMs: number },
  ): Promise<LogPatternAggregate> {
    const duplicate = this.results.has(result.eventId);
    this.results.set(result.eventId, structuredClone(result));
    const prior = this.patterns.get(result.patternId);
    const inWindow =
      prior !== undefined &&
      Date.parse(result.timestamp) - Date.parse(prior.lastSeen) <=
        context.aggregationWindowMs;
    const current = inWindow ? prior : undefined;
    const pods = new Set(current?.affectedPods ?? []);
    if (context.pod) pods.add(context.pod);
    const aggregate: LogPatternAggregate = {
      patternId: result.patternId,
      classification: result.classification,
      count: (current?.count ?? 0) + (duplicate ? 0 : 1),
      firstSeen:
        current && Date.parse(current.firstSeen) <= Date.parse(result.timestamp)
          ? current.firstSeen
          : result.timestamp,
      lastSeen:
        current && Date.parse(current.lastSeen) >= Date.parse(result.timestamp)
          ? current.lastSeen
          : result.timestamp,
      affectedPods: [...pods].sort(),
    };
    this.patterns.set(result.patternId, aggregate);
    while (this.results.size > this.capacity)
      this.results.delete(this.results.keys().next().value!);
    while (this.patterns.size > this.capacity)
      this.patterns.delete(this.patterns.keys().next().value!);
    return structuredClone(aggregate);
  }

  async get(eventId: string): Promise<LogClassificationResult | undefined> {
    const result = this.results.get(eventId);
    return result ? structuredClone(result) : undefined;
  }

  async getPattern(
    patternId: string,
  ): Promise<LogPatternAggregate | undefined> {
    const pattern = this.patterns.get(patternId);
    return pattern ? structuredClone(pattern) : undefined;
  }
}

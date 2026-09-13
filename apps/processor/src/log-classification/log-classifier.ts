import { createHash } from 'node:crypto';
import type {
  ActionableLogClassification,
  LogClassification,
  LogClassificationRepository,
  LogClassificationResult,
  MachineLearningLogClassifier,
} from '@faultline/log-classification';
import { LOG_CLASSIFICATION_TAXONOMY_VERSION } from '@faultline/log-classification';
import type { Anomaly, AnomalySeverity } from '@faultline/incidents';
import type { LogEvent } from '@faultline/telemetry';
import { resourceFromEvent } from '../rules/helpers';
import type {
  LogClassificationOutcome,
  LogClassifier,
  LogClassifierConfig,
} from './contracts';
import { logPatternId } from './fingerprint';
import { defaultLogPatternRules, type LogPatternRule } from './patterns';
import { HeuristicLogClassifier } from './heuristic-classifier';

export class StagedLogClassifier implements LogClassifier {
  constructor(
    private readonly repository: LogClassificationRepository,
    private readonly config: LogClassifierConfig,
    private readonly ml?: MachineLearningLogClassifier,
    private readonly rules: readonly LogPatternRule[] = defaultLogPatternRules,
  ) {}

  async classify(event: LogEvent): Promise<LogClassificationOutcome> {
    const result = this.config.enabled
      ? await this.classifyEnabled(event)
      : this.unknown(event, 'Log classification is disabled');
    const aggregate = await this.repository.save(result, {
      ...event,
      aggregationWindowMs: this.config.aggregationWindowMs,
    });
    const scoring = score(event, result.classification, aggregate, this.config);
    const anomaly =
      isActionable(result.classification) &&
      scoring.decision !== 'CLASSIFICATION'
        ? this.toAnomaly(event, result, aggregate, scoring)
        : undefined;
    return { result, aggregate, ...scoring, ...(anomaly ? { anomaly } : {}) };
  }

  private async classifyEnabled(
    event: LogEvent,
  ): Promise<LogClassificationResult> {
    const heuristic = new HeuristicLogClassifier(this.rules).classify(event);
    if (heuristic)
      return this.result(event, {
        classification: heuristic.classification,
        confidence: heuristic.confidence,
        classifierType: 'RULE',
        modelVersion: LOG_CLASSIFICATION_TAXONOMY_VERSION,
        summary: `Matched weighted semantic rule ${heuristic.ruleId}`,
        excerpt: heuristic.excerpt,
        matchedPattern: heuristic.ruleId,
        matchedSignals: heuristic.matchedSignals,
      });
    if (!this.ml)
      return this.unknown(event, 'No deterministic pattern matched');
    const prediction = await this.ml.classify(event);
    const classification =
      prediction.confidence < this.config.minimumConfidence
        ? 'UNKNOWN'
        : prediction.classification;
    return this.result(event, {
      classification,
      confidence: prediction.confidence,
      classifierType: 'ML',
      modelVersion: prediction.modelVersion,
      summary:
        classification === 'UNKNOWN'
          ? 'ML confidence was below the configured minimum'
          : 'Classified by the configured ML model',
      ...(prediction.evidence ? { excerpt: prediction.evidence } : {}),
    });
  }

  private unknown(event: LogEvent, summary: string): LogClassificationResult {
    return this.result(event, {
      classification: 'UNKNOWN',
      confidence: 0,
      classifierType: 'UNKNOWN',
      modelVersion: LOG_CLASSIFICATION_TAXONOMY_VERSION,
      summary,
    });
  }

  private result(
    event: LogEvent,
    value: {
      classification: LogClassification;
      confidence: number;
      classifierType: LogClassificationResult['classifierType'];
      modelVersion: string;
      summary: string;
      excerpt?: string;
      matchedPattern?: string;
      matchedSignals?: readonly string[];
    },
  ): LogClassificationResult {
    return {
      eventId: event.id,
      classification: value.classification,
      confidence: value.confidence,
      classifierType: value.classifierType,
      modelVersion: value.modelVersion,
      timestamp: event.timestamp,
      patternId: logPatternId(event, value.classification),
      evidence: [
        {
          summary: value.summary,
          ...(value.excerpt ? { excerpt: concise(value.excerpt) } : {}),
          ...(value.matchedPattern
            ? { matchedPattern: value.matchedPattern }
            : {}),
          ...(value.matchedSignals
            ? { matchedSignals: value.matchedSignals }
            : {}),
        },
      ],
    };
  }

  private toAnomaly(
    event: LogEvent,
    result: LogClassificationResult,
    aggregate: LogClassificationOutcome['aggregate'],
    scoring: Pick<
      LogClassificationOutcome,
      'score' | 'decision' | 'scoreReasons'
    >,
  ): Anomaly {
    const classification = result.classification as ActionableLogClassification;
    const resource = resourceFromEvent(event);
    const dedupeKey = `log:${classification}:${result.patternId}`;
    const anomalyId = createHash('sha256')
      .update(`${dedupeKey}:${aggregate.firstSeen}`)
      .digest('hex');
    const confidence = round(
      result.classifierType === 'ML' &&
        result.confidence < this.config.highConfidence
        ? result.confidence * 0.8
        : result.confidence,
    );
    return {
      anomalyId,
      dedupeKey,
      ruleId: `log-classifier.${result.modelVersion}`,
      classification,
      source: 'LOG_CLASSIFIER',
      severity: severity(scoring.score, this.config),
      anomalyScore: scoring.score,
      confidence,
      clusterId: event.clusterId,
      affectedResource: resource,
      timestamp: event.timestamp,
      summary: `${result.classification.replaceAll('_', ' ')}: ${aggregate.count} matching log${aggregate.count === 1 ? '' : 's'} across ${aggregate.affectedPods.length} pod${aggregate.affectedPods.length === 1 ? '' : 's'}; score ${scoring.score} (${scoring.decision})`,
      evidence: [
        {
          type: 'log-pattern',
          summary: result.evidence[0]!.summary,
          timestamp: event.timestamp,
          eventId: event.id,
          attributes: {
            classification: result.classification,
            confidence: result.confidence,
            classifierType: result.classifierType,
            modelVersion: result.modelVersion,
            patternId: result.patternId,
            count: aggregate.count,
            affectedPods: aggregate.affectedPods.length,
            excerpt: result.evidence[0]!.excerpt ?? '',
            matchedSignals: (result.evidence[0]!.matchedSignals ?? []).join(
              ', ',
            ),
            incidentScore: scoring.score,
            decision: scoring.decision,
            scoreReasons: scoring.scoreReasons.join('; '),
          },
        },
      ],
      status: aggregate.count === 1 ? 'OPEN' : 'ACTIVE',
      firstSeen: aggregate.firstSeen,
      lastSeen: event.timestamp,
    };
  }
}

function isActionable(
  classification: LogClassification,
): classification is ActionableLogClassification {
  return classification !== 'NORMAL' && classification !== 'UNKNOWN';
}

function concise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function score(
  event: LogEvent,
  classification: LogClassification,
  aggregate: LogClassificationOutcome['aggregate'],
  config: LogClassifierConfig,
): Pick<LogClassificationOutcome, 'score' | 'decision' | 'scoreReasons'> {
  let value = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    value += points;
    reasons.push(`${reason} +${points}`);
  };
  if (isActionable(classification))
    add(config.scoring.knownClassification, 'known semantic classification');
  if (event.level === 'error')
    add(config.scoring.errorSeverity, 'ERROR severity');
  if (event.level === 'fatal')
    add(config.scoring.fatalSeverity, 'FATAL severity');
  if (aggregate.count >= config.scoring.frequentOccurrenceThreshold)
    add(config.scoring.frequent, `${aggregate.count} repetitions`);
  else if (aggregate.count >= config.scoring.repeatedOccurrenceThreshold)
    add(config.scoring.repeated, `${aggregate.count} repetitions`);
  if (aggregate.affectedPods.length > 1)
    add(
      config.scoring.multiplePods,
      `${aggregate.affectedPods.length} pods affected`,
    );
  const decision =
    value >= config.scoring.incidentThreshold
      ? 'INCIDENT'
      : value >= config.scoring.anomalyThreshold
        ? 'ANOMALY'
        : 'CLASSIFICATION';
  return { score: value, decision, scoreReasons: reasons };
}

function severity(score: number, config: LogClassifierConfig): AnomalySeverity {
  if (score >= config.scoring.incidentThreshold) return 'HIGH';
  return 'WARNING';
}

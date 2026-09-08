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
    const anomaly = isActionable(result.classification)
      ? this.toAnomaly(event, result, aggregate)
      : undefined;
    return { result, aggregate, ...(anomaly ? { anomaly } : {}) };
  }

  private async classifyEnabled(
    event: LogEvent,
  ): Promise<LogClassificationResult> {
    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        const match = pattern.exec(event.message);
        pattern.lastIndex = 0;
        if (!match) continue;
        return this.result(event, {
          classification: rule.classification,
          confidence: rule.confidence,
          classifierType: 'RULE',
          modelVersion: LOG_CLASSIFICATION_TAXONOMY_VERSION,
          summary: `Matched deterministic log rule ${rule.id}`,
          excerpt: match[0],
          matchedPattern: rule.id,
        });
      }
    }
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
        },
      ],
    };
  }

  private toAnomaly(
    event: LogEvent,
    result: LogClassificationResult,
    aggregate: LogClassificationOutcome['aggregate'],
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
      severity: severity(classification, aggregate.count),
      confidence,
      clusterId: event.clusterId,
      affectedResource: resource,
      timestamp: event.timestamp,
      summary: `${result.classification.replaceAll('_', ' ')} log pattern observed ${aggregate.count} time${aggregate.count === 1 ? '' : 's'}`,
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

function severity(
  classification: ActionableLogClassification,
  count: number,
): AnomalySeverity {
  if (classification === 'RESOURCE_EXHAUSTION' || count >= 20) return 'HIGH';
  if (count >= 5) return 'WARNING';
  return 'INFO';
}

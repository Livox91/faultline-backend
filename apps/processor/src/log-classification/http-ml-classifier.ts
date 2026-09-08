import {
  logClassifications,
  type MachineLearningLogClassifier,
  type MlLogClassification,
} from '@faultline/log-classification';
import type { LogEvent } from '@faultline/telemetry';

/** Optional transport adapter for an isolated Python model runtime. */
export class HttpMachineLearningLogClassifier implements MachineLearningLogClassifier {
  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number,
  ) {}

  async classify(event: LogEvent): Promise<MlLogClassification> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: event.id,
        timestamp: event.timestamp,
        level: event.level,
        message: event.message,
        service: event.service,
        workload: event.workload,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`ML classifier returned HTTP ${response.status}`);
    const value = (await response.json()) as Record<string, unknown>;
    if (
      typeof value.classification !== 'string' ||
      !logClassifications.includes(
        value.classification as (typeof logClassifications)[number],
      ) ||
      typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1 ||
      typeof value.modelVersion !== 'string' ||
      !value.modelVersion.trim()
    )
      throw new Error('ML classifier returned an invalid response');
    return {
      classification:
        value.classification as MlLogClassification['classification'],
      confidence: value.confidence,
      modelVersion: value.modelVersion,
      ...(typeof value.evidence === 'string'
        ? { evidence: value.evidence.slice(0, 200) }
        : {}),
    };
  }
}

import { createHash } from 'node:crypto';
import type { LogClassification } from '@faultline/log-classification';
import type { LogEvent } from '@faultline/telemetry';

/** Basic grouping only: remove volatile identifiers while retaining useful words. */
export function normalizeLogPattern(message: string): string {
  return message
    .toLowerCase()
    .replace(
      /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/gi,
      '<timestamp>',
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(
      /\b((?:request|trace|correlation)[-_ ]?id)\s*[=:]\s*[a-z0-9._-]+/gi,
      '$1=<id>',
    )
    .replace(
      /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-[a-f0-9]{8,10}-[a-z0-9]{5}\b/gi,
      '$1-<pod>',
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function logPatternId(
  event: LogEvent,
  classification: LogClassification,
): string {
  const scope = [
    event.clusterId,
    event.namespace ?? '',
    event.workload ?? event.service ?? '',
    classification,
    normalizeLogPattern(event.message),
  ].join(':');
  return createHash('sha256').update(scope).digest('hex').slice(0, 24);
}

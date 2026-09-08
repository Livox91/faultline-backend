import { createHash } from 'node:crypto';
import type { LogClassification } from '@faultline/log-classification';
import type { LogEvent } from '@faultline/telemetry';

/** Basic grouping only: remove volatile identifiers while retaining useful words. */
export function normalizeLogPattern(message: string): string {
  return message
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
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

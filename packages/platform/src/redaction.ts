export const REDACTED_VALUE = '[REDACTED]';

/** Shared boundary redaction for normalized operational content. */
export function sanitizeSensitiveContent(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>());
}

/** Redacts secrets embedded in summaries, findings, remediation text, and metadata. */
export function redactSensitiveText(value: string): string {
  return value
    .replaceAll(
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/[^\s"'<>\]),;]+/gi,
      '[REDACTED_CONNECTION_STRING]',
    )
    .replaceAll(
      /\b(?:https?|ftp):\/\/[^\s\/:@]+:[^\s\/@]+@[^\s"'<>\]),;]+/gi,
      '[REDACTED_CONNECTION_STRING]',
    )
    .replaceAll(
      /\b(database[-_ ]?url|db[-_ ]?url|connection[-_ ]?string)\s*[:=]\s*[^\r\n]+/gi,
      '$1=[REDACTED]',
    )
    .replaceAll(
      /\b((?:proxy[-_ ]?)?authorization)\s*[:=]\s*[^\r\n,;]+/gi,
      '$1=[REDACTED]',
    )
    .replaceAll(
      /\b(cookie|set[-_ ]?cookie)\s*[:=]\s*[^\r\n]+/gi,
      '$1=[REDACTED]',
    )
    .replaceAll(
      /\b([a-z0-9-]*(?:secret|api-key|access-token|refresh-token)[a-z0-9-]*[-_ ]?header)\s*[:=]\s*[^\r\n,;]+/gi,
      '$1=[REDACTED]',
    )
    .replaceAll(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replaceAll(
      /\b((?:proxy[-_ ]?)?authorization|api[-_ ]?key|x[-_ ]?api[-_ ]?key|token|password|passwd|cookie|set[-_ ]?cookie|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret[-_ ]?header|x[-_ ]?secret|database[-_ ]?url|db[-_ ]?url|connection[-_ ]?string)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replaceAll(
      /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL|DB_URL|CONNECTION_STRING))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
      '$1=[REDACTED]',
    )
    .replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replaceAll(/\b(?:xox[baprs]-|gh[pousr]_|sk-(?:live|test)-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_TOKEN]')
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replaceAll(/(?<!\w)\+[1-9]\d{7,14}\b/g, '[REDACTED_PHONE]');
}

function sanitize(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return undefined;
  if (ancestors.has(value)) throw new TypeError('Content contains a circular reference');

  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => sanitize(item, ancestors) ?? null);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED_VALUE;
        continue;
      }
      const sanitized = sanitize(item, ancestors);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized.endsWith('authorization') ||
    normalized === 'apikey' ||
    normalized.endsWith('password') ||
    normalized.endsWith('passwd') ||
    normalized.includes('secret') ||
    normalized.endsWith('token') ||
    normalized.endsWith('credential') ||
    normalized.endsWith('credentials') ||
    normalized === 'cookie' ||
    normalized === 'cookies' ||
    normalized === 'setcookie' ||
    normalized.endsWith('databaseurl') ||
    normalized.endsWith('dburl') ||
    normalized.endsWith('connectionstring') ||
    normalized.endsWith('datasourceurl') ||
    normalized.endsWith('privatekey')
  );
}

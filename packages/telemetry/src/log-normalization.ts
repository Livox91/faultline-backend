export const normalizedLogSeverities = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'unknown',
] as const;

export type NormalizedLogSeverity = (typeof normalizedLogSeverities)[number];

export const severitySources = [
  'OTLP_TEXT',
  'OTLP_NUMBER',
  'STRUCTURED_BODY',
  'MESSAGE_PARSE',
  'STREAM_HINT',
  'UNKNOWN',
] as const;

export type SeveritySource = (typeof severitySources)[number];

export interface LogNormalizationInput {
  severityText?: string;
  severityNumber?: number;
  body: unknown;
  stream?: unknown;
}

export interface NormalizedLog {
  level: NormalizedLogSeverity;
  severitySource: SeveritySource;
  message: string;
}

const severityLabels: Readonly<Record<string, NormalizedLogSeverity>> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  err: 'error',
  error: 'error',
  fatal: 'fatal',
  critical: 'fatal',
};

const structuredSeverityFields = [
  'level',
  'severity',
  'severityText',
  'logLevel',
  'lvl',
] as const;

// CSI and OSC control sequences cover colors emitted by NestJS and common loggers.
const ansiEscape =
  /[\u001b\u009b](?:(?:\][^\u0007]*(?:\u0007|\u001b\\))|(?:\[[0-?]*[ -/]*[@-~])|[@-_])/g;

export function stripAnsi(value: string): string {
  return value.replace(ansiEscape, '');
}

function cleanMessage(value: string): string {
  const clean = stripAnsi(value);
  // Color boundaries often leave framework-padding behind. Only normalize that
  // padding when an escape was actually removed; untouched logs remain byte-stable.
  return clean === value ? value : clean.replace(/[ \t]+/g, ' ').trim();
}

function severityLabel(value: unknown): NormalizedLogSeverity | undefined {
  if (typeof value !== 'string') return undefined;
  return severityLabels[value.trim().toLowerCase()];
}

function structuredBody(body: unknown): Record<string, unknown> | undefined {
  if (body && typeof body === 'object' && !Array.isArray(body))
    return body as Record<string, unknown>;
  if (typeof body !== 'string') return undefined;
  const candidate = body.trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedMessage(
  body: unknown,
  structured: Record<string, unknown> | undefined,
): string {
  // `msg` is the established concise-message convention used by etcd/zap logs.
  // Other structured bodies retain their complete JSON representation for compatibility.
  const structuredMessage = structured?.msg;
  if (typeof structuredMessage === 'string')
    return cleanMessage(structuredMessage);
  if (typeof body === 'string') return cleanMessage(body);
  return cleanMessage(JSON.stringify(body));
}

function severityFromMessage(
  message: string,
): NormalizedLogSeverity | undefined {
  const match =
    /(?:^|[^A-Za-z0-9_])(TRACE|DEBUG|INFO|WARN(?:ING)?|ERR(?:OR)?|FATAL|CRITICAL)(?=$|[^A-Za-z0-9_])/i.exec(
      message,
    );
  return match?.[1] ? severityLabel(match[1]) : undefined;
}

function severityFromNumber(value: number): NormalizedLogSeverity {
  return ['trace', 'debug', 'info', 'warn', 'error', 'fatal'][
    Math.floor((value - 1) / 4)
  ] as NormalizedLogSeverity;
}

/**
 * One normalization boundary for every OTLP log. Precedence is explicit text,
 * non-zero OTLP number, structured body, clean message, stream hint, unknown.
 */
export function normalizeLog(input: LogNormalizationInput): NormalizedLog {
  const severityNumber = input.severityNumber ?? 0;
  if (
    !Number.isInteger(severityNumber) ||
    severityNumber < 0 ||
    severityNumber > 24
  )
    throw new Error('Invalid severity');

  const structured = structuredBody(input.body);
  const message = normalizedMessage(input.body, structured);
  const explicit = severityLabel(input.severityText);
  if (explicit)
    return { level: explicit, severitySource: 'OTLP_TEXT', message };

  // OTLP SeverityNumber 0 is UNSPECIFIED and must not stop fallback parsing.
  if (severityNumber > 0)
    return {
      level: severityFromNumber(severityNumber),
      severitySource: 'OTLP_NUMBER',
      message,
    };

  for (const field of structuredSeverityFields) {
    const level = severityLabel(structured?.[field]);
    if (level) return { level, severitySource: 'STRUCTURED_BODY', message };
  }

  const parsed = severityFromMessage(message);
  if (parsed)
    return { level: parsed, severitySource: 'MESSAGE_PARSE', message };

  // stderr is retained as evidence but deliberately does not imply an error.
  if (input.stream === 'stderr')
    return { level: 'unknown', severitySource: 'STREAM_HINT', message };
  return { level: 'unknown', severitySource: 'UNKNOWN', message };
}

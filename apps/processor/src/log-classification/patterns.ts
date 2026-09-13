import type { LogClassification } from '@faultline/log-classification';

export interface SemanticSignal {
  label: string;
  pattern: RegExp;
  weight: number;
}
export interface LogPatternRule {
  id: string;
  classification: LogClassification;
  minimumWeight: number;
  signals: readonly SemanticSignal[];
}
const s = (label: string, pattern: RegExp, weight: number): SemanticSignal => ({
  label,
  pattern,
  weight,
});
const rule = (
  id: string,
  classification: LogClassification,
  signals: readonly SemanticSignal[],
  minimumWeight = 0.75,
): LogPatternRule => ({ id, classification, minimumWeight, signals });

/** Framework-neutral operational semantics. Rule order only breaks equal-score ties. */
export const defaultLogPatternRules: readonly LogPatternRule[] = [
  rule('normal-low-value', 'NORMAL', [
    s(
      'health check succeeded',
      /\bhealth\s*check\s+(?:ok|success(?:ful)?)\b/i,
      1,
    ),
    s('heartbeat', /\b(?:debug\s+)?heartbeat\b/i, 1),
    s('started successfully', /\bstarted successfully\b/i, 1),
  ]),
  rule('database-connectivity', 'DATABASE_CONNECTIVITY', [
    s('connection refused', /\b(?:econnrefused|connection refused)\b/i, 0.82),
    s('could not connect', /\b(?:could not|cannot|unable to) connect\b/i, 0.72),
    s('database unavailable', /\bdatabase\s+(?:is\s+)?unavailable\b/i, 0.82),
    s(
      'database connection failed',
      /\bdatabase connection (?:failed|failure)\b/i,
      0.82,
    ),
    s(
      'database connection timed out',
      /\bconnection to (?:the )?database\s+(?:timed out|timeout)\b/i,
      0.82,
    ),
    s('connection reset', /\b(?:econnreset|connection reset)\b/i, 0.58),
    s(
      'database context',
      /\b(?:database|sql|postgres(?:ql)?|mysql|mongodb|redis)\b/i,
      0.22,
    ),
    s('connection context', /\bconnect(?:ion)?\b/i, 0.12),
  ]),
  rule('dependency-timeout', 'DEPENDENCY_TIMEOUT', [
    s('deadline exceeded', /\bdeadline exceeded\b/i, 0.82),
    s('gateway timeout', /\bgateway timeout\b/i, 0.82),
    s('service unavailable', /\bservice unavailable\b/i, 0.78),
    s('request timed out', /\brequest (?:timed out|timeout)\b/i, 0.78),
    s('timeout', /\b(?:timed out|timeout|etimedout)\b/i, 0.42),
    s(
      'dependency context',
      /\b(?:upstream|downstream|dependency|service|request)\b/i,
      0.4,
    ),
  ]),
  rule('authentication-failure', 'AUTHENTICATION_FAILURE', [
    s('authentication failed', /\bauthentication failed\b/i, 0.88),
    s('invalid credentials', /\binvalid credentials\b/i, 0.88),
    s('login failed', /\blogin failed\b/i, 0.82),
    s('unauthenticated', /\bunauthenticated\b/i, 0.82),
    s('invalid token', /\binvalid token\b/i, 0.82),
    s('token expired', /\btoken expired\b/i, 0.82),
    s('HTTP 401', /\b401\b/i, 0.42),
    s(
      'authentication context',
      /\b(?:auth(?:entication)?|credentials?|login|token)\b/i,
      0.38,
    ),
  ]),
  rule('authorization-failure', 'AUTHORIZATION_FAILURE', [
    s('permission denied', /\bpermission denied\b/i, 0.88),
    s('access denied', /\baccess denied\b/i, 0.88),
    s('not authorized', /\bnot authorized\b/i, 0.86),
    s('insufficient permissions', /\binsufficient permissions?\b/i, 0.86),
    s('forbidden', /\bforbidden\b/i, 0.72),
    s('HTTP 403', /\b403\b/i, 0.36),
  ]),
  rule('configuration-error', 'CONFIGURATION_ERROR', [
    s(
      'missing configuration',
      /\b(?:missing configuration|configuration missing)\b/i,
      0.86,
    ),
    s(
      'invalid configuration',
      /\b(?:invalid configuration|configuration (?:is )?invalid)\b/i,
      0.86,
    ),
    s(
      'environment variable missing',
      /\b(?:environment variable|env(?:ironment)? var(?:iable)?)[^\n]*(?:missing|not set|required)\b/i,
      0.86,
    ),
    s('failed to load config', /\bfailed to load config(?:uration)?\b/i, 0.86),
    s(
      'configuration value invalid',
      /\bconfiguration value (?:is )?invalid\b/i,
      0.86,
    ),
  ]),
  rule('storage-failure', 'STORAGE_FAILURE', [
    s('I/O error', /\b(?:i\/o|input\/output) error\b/i, 0.84),
    s('read-only filesystem', /\bread-only file ?system\b/i, 0.88),
    s(
      'storage unavailable',
      /\bstorage (?:is )?(?:unavailable|failure)\b/i,
      0.84,
    ),
    s('volume mount failure', /\bvolume mount (?:failed|failure)\b/i, 0.84),
    s('disk full', /\b(?:disk (?:is )?full|no space left on device)\b/i, 0.78),
    s('storage context', /\b(?:disk|storage|volume|filesystem)\b/i, 0.2),
  ]),
  rule('resource-exhaustion', 'RESOURCE_EXHAUSTION', [
    s('out of memory', /\bout of memory\b/i, 0.9),
    s('cannot allocate memory', /\bcannot allocate memory\b/i, 0.9),
    s(
      'heap exhausted',
      /\bheap (?:space )?(?:exhausted|limit|allocation failed)\b/i,
      0.86,
    ),
    s('resource exhausted', /\bresource exhausted\b/i, 0.86),
    s('too many open files', /\btoo many open files\b/i, 0.86),
    s('disk full', /\b(?:disk (?:is )?full|no space left on device)\b/i, 0.7),
    s(
      'resource context',
      /\b(?:memory|heap|resource|file descriptors?)\b/i,
      0.18,
    ),
  ]),
  rule('rate-limiting', 'RATE_LIMITING', [
    s('rate limit exceeded', /\brate limit(?:ed| exceeded)\b/i, 0.88),
    s('too many requests', /\btoo many requests\b/i, 0.88),
    s('throttled', /\bthrottl(?:ed|ing)\b/i, 0.82),
    s('quota exceeded', /\bquota exceeded\b/i, 0.82),
    s('HTTP 429', /\b429\b/i, 0.52),
  ]),
  rule('network-failure', 'NETWORK_FAILURE', [
    s('network unreachable', /\b(?:network unreachable|enetunreach)\b/i, 0.88),
    s('host unreachable', /\b(?:host unreachable|ehostunreach)\b/i, 0.88),
    s(
      'DNS lookup failed',
      /\b(?:dns lookup failed|getaddrinfo\s+eai_(?:again|noname))\b/i,
      0.88,
    ),
    s('socket closed', /\bsocket (?:is )?closed\b/i, 0.82),
    s('broken pipe', /\bbroken pipe\b/i, 0.84),
    s('connection reset', /\b(?:connection reset|econnreset)\b/i, 0.76),
  ]),
  rule('startup-failure', 'STARTUP_FAILURE', [
    s('failed to start', /\bfailed to start\b/i, 0.86),
    s('startup failed', /\bstartup failed\b/i, 0.86),
    s(
      'initialization failed',
      /\b(?:initialization failed|failed during initialization)\b/i,
      0.86,
    ),
    s('cannot initialize', /\b(?:cannot|unable to) initialize\b/i, 0.84),
  ]),
  rule('application-exception', 'APPLICATION_EXCEPTION', [
    s('unhandled exception', /\bunhandled (?:exception|rejection)\b/i, 0.9),
    s(
      'runtime exception',
      /\b(?:type|reference|runtime|illegalstate)error\b/i,
      0.84,
    ),
    s('exception', /\bexception(?: in thread|:)\b/i, 0.78),
    s('panic', /\bpanic(?:ked)?\b/i, 0.82),
    s('stack trace', /\bstack trace\b/i, 0.78),
  ]),
];

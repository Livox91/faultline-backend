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
      'database authentication failed',
      /\b(?:password authentication failed|authentication failed for (?:user|database user))\b/i,
      1.3,
    ),
    s(
      'database does not exist',
      /\bdatabase ["'`]?[^\s"'`]+["'`]? does not exist\b/i,
      0.92,
    ),
    s(
      'database connection limit exceeded',
      /\b(?:too many (?:database )?connections|remaining connection slots are reserved)\b/i,
      0.9,
    ),
    s(
      'database pool exhausted',
      /\b(?:connection pool (?:is )?(?:exhausted|full)|timed out (?:fetching|acquiring) (?:a )?connection from (?:the )?pool)\b/i,
      0.9,
    ),
    s(
      'database client initialization failed',
      /\bPrismaClientInitializationError\b/i,
      0.92,
    ),
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
    s('connection timed out', /\bETIMEDOUT\b/i, 0.84),
    s(
      'upstream HTTP failure',
      /\b(?:502 bad gateway|503 service unavailable|504 gateway timeout)\b/i,
      0.9,
    ),
    s(
      'external service timeout',
      /\b(?:external|third[- ]party|remote|provider|upstream) (?:api |service )?(?:request )?(?:timed out|timeout)\b/i,
      0.88,
    ),
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
    s('JWT malformed', /\bjwt malformed\b/i, 0.9),
    s('JWT signature invalid', /\b(?:jwt )?invalid signature\b/i, 0.88),
    s('JWT expired', /\bjwt expired\b/i, 0.9),
    s('token missing', /\btoken (?:not provided|missing)\b/i, 0.86),
    s(
      'session missing',
      /\bsession (?:not found|missing|expired|invalid)\b/i,
      0.84,
    ),
    s(
      'CSRF validation failed',
      /\b(?:csrf|cross[- ]site request forgery)[^\n]*(?:fail(?:ed|ure)?|invalid|missing)\b/i,
      0.88,
    ),
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
    s('object storage access denied', /\b(?:s3[ :]+)?AccessDenied\b/i, 0.9),
    s('request signature mismatch', /\bSignatureDoesNotMatch\b/i, 0.9),
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
    s(
      'invalid environment value',
      /\b(?:invalid|incorrect|unsupported) (?:value for )?(?:environment variable|env(?:ironment)? var(?:iable)?)\b/i,
      0.86,
    ),
    s(
      'CORS configuration failure',
      /\b(?:blocked by cors policy|cors policy error|cors validation failed|not allowed by access-control-allow-origin)\b/i,
      0.9,
    ),
    s(
      'database schema missing',
      /\b(?:relation|column) ["'`]?[^\s"'`]+["'`]? does not exist\b/i,
      0.9,
    ),
    s(
      'migration missing',
      /\b(?:migration (?:was )?not applied|missing (?:database )?migration|schema migration (?:failed|missing))\b/i,
      0.9,
    ),
    s('unsupported media type', /\b415 unsupported media type\b/i, 0.8),
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
    s(
      'filesystem permission failure',
      /\bEACCES[ :][^\n]*(?:open|read|write|mkdir|file|directory|permission denied)\b/i,
      0.9,
    ),
    s(
      'file not found',
      /\bENOENT[ :][^\n]*(?:no such file or directory|open|stat)\b/i,
      0.86,
    ),
    s(
      'upload rejected',
      /\b(?:presigned (?:url )?(?:expired|invalid)|upload (?:failed|rejected))\b/i,
      0.84,
    ),
    s('unexpected upload field', /\bMulterError:\s*Unexpected field\b/i, 0.9),
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
    s(
      'JavaScript heap exhausted',
      /\b(?:JavaScript heap out of memory|heap out of memory|allocation failed[^\n]*heap limit)\b/i,
      0.94,
    ),
    s('memory allocation failed', /\bENOMEM\b/i, 0.9),
    s(
      'process killed by memory limit',
      /\b(?:SIGKILL|exit(?:ed)?(?: with)? code 137|OOMKilled)\b/i,
      0.86,
    ),
    s(
      'worker pool exhausted',
      /\b(?:thread|worker) pool (?:is )?(?:exhausted|saturated|full)\b/i,
      0.88,
    ),
    s(
      'event loop blocked',
      /\b(?:event[- ]loop (?:is )?(?:blocked|stalled)|blocked event[- ]loop)\b/i,
      0.84,
    ),
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
    s(
      'host lookup failed',
      /\b(?:ENOTFOUND|getaddrinfo\s+ENOTFOUND|EAI_AGAIN)\b/i,
      0.9,
    ),
    s('socket hang up', /\bsocket hang up\b/i, 0.88),
    s('fetch failed', /\bfetch failed\b/i, 0.9),
    s(
      'TLS certificate failure',
      /\b(?:certificate (?:has expired|verify failed|verification failed)|unable to verify the first certificate|self[- ]signed certificate|hostname.*does not match certificate|ERR_TLS_CERT_ALTNAME_INVALID)\b/i,
      0.9,
    ),
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
    s('module missing', /\bCannot find module\b/i, 0.9),
    s('ES module missing', /\bERR_MODULE_NOT_FOUND\b/i, 0.92),
    s('ES module required', /\bERR_REQUIRE_ESM\b/i, 0.92),
    s('address already in use', /\bEADDRINUSE\b/i, 0.9),
    s(
      'container repeatedly exits',
      /\b(?:container|application|process) (?:exits?|restarts?) repeatedly\b/i,
      0.86,
    ),
  ]),
  rule('database-operation-failure', 'APPLICATION_EXCEPTION', [
    s(
      'unique constraint violation',
      /\b(?:unique constraint (?:violation|failed)|duplicate key value violates unique constraint)\b/i,
      0.9,
    ),
    s(
      'foreign key violation',
      /\b(?:foreign key constraint (?:violation|failed)|violates foreign key constraint)\b/i,
      0.9,
    ),
    s(
      'null constraint violation',
      /\b(?:null constraint violation|null value in column[^\n]*violates not-null constraint)\b/i,
      0.9,
    ),
    s('database deadlock', /\bdeadlock detected\b/i, 0.92),
    s(
      'transaction invalid',
      /\btransaction (?:already closed|is closed|has been aborted)\b/i,
      0.88,
    ),
    s('slow database query', /\bslow (?:database )?quer(?:y|ies)\b/i, 0.8),
  ]),
  rule('frontend-runtime-failure', 'APPLICATION_EXCEPTION', [
    s('hydration failed', /\bhydration failed\b/i, 0.9),
    s(
      'server-side browser API access',
      /\b(?:window|document|localStorage|self) is not defined\b/i,
      0.9,
    ),
    s(
      'chunk load failed',
      /\b(?:ChunkLoadError|Loading chunk [^\n]* failed)\b/i,
      0.9,
    ),
    s('React hydration error', /\bReact error #418\b/i, 0.88),
    s('React render loop', /\bToo many re-renders\b/i, 0.9),
    s('React update loop', /\bMaximum update depth exceeded\b/i, 0.9),
  ]),
  rule('background-work-failure', 'APPLICATION_EXCEPTION', [
    s(
      'background job failed',
      /\b(?:background |scheduled |cron )?job [^\n]*(?:failed|failure)\b/i,
      0.86,
    ),
    s(
      'duplicate job execution',
      /\bduplicate job (?:execution|detected)\b/i,
      0.86,
    ),
    s('race condition', /\brace condition (?:detected|encountered)\b/i, 0.86),
    s(
      'partial failure consistency error',
      /\b(?:data inconsistency|inconsistent data) (?:after|due to|caused by) partial failure\b/i,
      0.88,
    ),
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
    s(
      'undefined or null property access',
      /\bTypeError:\s*Cannot read propert(?:y|ies) of (?:undefined|null)\b/i,
      0.94,
    ),
    s(
      'undefined reference',
      /\bReferenceError:\s*[^\n]+ is not defined\b/i,
      0.92,
    ),
    s('non-callable value', /\bTypeError:\s*[^\n]+ is not a function\b/i, 0.92),
    s('runtime syntax error', /\bSyntaxError:\s*Unexpected token\b/i, 0.9),
    s(
      'unhandled promise rejection',
      /\bUnhandledPromiseRejection(?:Warning|Error)?\b/i,
      0.94,
    ),
    s('uncaught exception', /\bUncaughtException\b/i, 0.94),
    s('call stack exhausted', /\bMaximum call stack size exceeded\b/i, 0.94),
    s('invalid array length', /\bRangeError:\s*Invalid array length\b/i, 0.9),
    s(
      'HTTP headers already sent',
      /\b(?:ERR_HTTP_HEADERS_SENT|Cannot set headers after they are sent)\b/i,
      0.92,
    ),
    s(
      'internal server error',
      /\b(?:500 Internal Server Error|request (?:failed|completed) with (?:status )?500)\b/i,
      0.84,
    ),
  ]),
];

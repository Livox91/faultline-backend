import type { LogClassification } from '@faultline/log-classification';

export interface LogPatternRule {
  id: string;
  classification: LogClassification;
  confidence: number;
  patterns: readonly RegExp[];
}

/**
 * Configurable deterministic vocabulary, deliberately isolated from ML orchestration.
 * Order is significant where messages contain terms from more than one category.
 */
export const defaultLogPatternRules: readonly LogPatternRule[] = [
  {
    id: 'normal-low-value',
    classification: 'NORMAL',
    confidence: 0.99,
    patterns: [
      /\bhealth\s*check\s+(?:ok|success(?:ful)?)\b/i,
      /\b(?:debug\s+)?heartbeat\b/i,
      /\bstarted successfully\b/i,
    ],
  },
  {
    id: 'database-connectivity',
    classification: 'DATABASE_CONNECTIVITY',
    confidence: 0.99,
    patterns: [
      /\beconnrefused\b/i,
      /\bconnection refused\b/i,
      /\bdatabase unavailable\b/i,
      /\b(?:postgres(?:ql)?|mysql|mongodb|redis).*\b(?:unavailable|connection failed)\b/i,
    ],
  },
  {
    id: 'dependency-timeout',
    classification: 'DEPENDENCY_TIMEOUT',
    confidence: 0.97,
    patterns: [
      /\b(?:dependency|upstream|downstream).*(?:timed? out|timeout)\b/i,
      /\b(?:timed? out|timeout).*(?:dependency|upstream|downstream)\b/i,
      /\betimedout\b/i,
      /\bgateway timeout\b/i,
    ],
  },
  {
    id: 'authentication-failure',
    classification: 'AUTHENTICATION_FAILURE',
    confidence: 0.98,
    patterns: [
      /\bauthentication failed\b/i,
      /\binvalid credentials\b/i,
      /\b401\b.*\b(?:unauthorized|authentication|credentials?)\b/i,
      /\bunauthorized\b.*\b401\b/i,
    ],
  },
  {
    id: 'authorization-failure',
    classification: 'AUTHORIZATION_FAILURE',
    confidence: 0.98,
    patterns: [
      /\b403\b.*\bforbidden\b/i,
      /\b(?:permission|access) denied\b/i,
      /\bnot authorized\b/i,
    ],
  },
  {
    id: 'configuration-error',
    classification: 'CONFIGURATION_ERROR',
    confidence: 0.97,
    patterns: [
      /\bconfiguration (?:error|invalid|missing)\b/i,
      /\binvalid config(?:uration)?\b/i,
      /\brequired (?:configuration|environment variable).*\b(?:missing|not set)\b/i,
      /\benvironment variable\b.*\bnot set\b/i,
    ],
  },
  {
    id: 'storage-failure',
    classification: 'STORAGE_FAILURE',
    confidence: 0.98,
    patterns: [
      /\bno space left on device\b/i,
      /\bdisk (?:is )?full\b/i,
      /\bread-only file ?system\b/i,
      /\bstorage (?:unavailable|failure)\b/i,
    ],
  },
  {
    id: 'resource-exhaustion',
    classification: 'RESOURCE_EXHAUSTION',
    confidence: 0.98,
    patterns: [
      /\bout of memory\b/i,
      /\bheap (?:space )?(?:exhausted|limit|allocation failed)\b/i,
      /\btoo many open files\b/i,
      /\bresource exhausted\b/i,
    ],
  },
  {
    id: 'rate-limiting',
    classification: 'RATE_LIMITING',
    confidence: 0.98,
    patterns: [
      /\brate limit(?:ed| exceeded)?\b/i,
      /\btoo many requests\b/i,
      /\b429\b.*\b(?:requests?|rate)\b/i,
    ],
  },
  {
    id: 'network-failure',
    classification: 'NETWORK_FAILURE',
    confidence: 0.96,
    patterns: [
      /\b(?:enetunreach|ehostunreach|econnreset)\b/i,
      /\bnetwork (?:is )?(?:unreachable|unavailable)\b/i,
      /\bdns (?:lookup )?(?:failed|failure)\b/i,
      /\bsocket hang up\b/i,
    ],
  },
  {
    id: 'startup-failure',
    classification: 'STARTUP_FAILURE',
    confidence: 0.97,
    patterns: [
      /\b(?:startup|bootstrap|initialization) failed\b/i,
      /\bfailed to start\b/i,
    ],
  },
  {
    id: 'application-exception',
    classification: 'APPLICATION_EXCEPTION',
    confidence: 0.95,
    patterns: [
      /\bunhandled (?:exception|rejection)\b/i,
      /\b(?:type|reference|runtime|illegalstate)error\b/i,
      /\bexception(?: in thread|:)\b/i,
      /\bstack trace\b/i,
    ],
  },
];

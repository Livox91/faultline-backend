import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Access tokens: HS256 JWTs, issued and verified here.
 *
 * A standard JWT rather than an opaque session because the enterprise identity sources
 * this has to grow into - SSO, OIDC, LDAP behind a broker - all speak it. Swapping to an
 * external issuer later means replacing `verifyAccessToken` with RS256 verification
 * against a JWKS and leaving every caller alone, which is why the guard consumes claims
 * through this module rather than parsing tokens itself.
 *
 * The token carries identity only. Role is included for logging and for the client's
 * first paint, but no authorization decision reads it: the guard re-loads the user and
 * their assignments from storage on every request, so revoking an assignment takes
 * effect immediately instead of at token expiry.
 */

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  email: string;
  role: string;
  iss: string;
  iat: number;
  exp: number;
  /** Set once a second factor has been satisfied; absent when MFA is not in play. */
  amr?: readonly string[];
}

export interface TokenSettings {
  readonly secret: string;
  readonly issuer: string;
  readonly ttlSeconds: number;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

const encode = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueAccessToken(
  claims: Omit<AccessTokenClaims, 'iss' | 'iat' | 'exp'>,
  settings: TokenSettings,
  now: number = Date.now(),
): { token: string; expiresAt: string } {
  if (!settings.secret) throw new TokenError('Token secret is not configured');
  const issuedAt = Math.floor(now / 1000);
  const payload: AccessTokenClaims = {
    ...claims,
    iss: settings.issuer,
    iat: issuedAt,
    exp: issuedAt + settings.ttlSeconds,
  };
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const token = `${head}.${body}.${sign(`${head}.${body}`, settings.secret)}`;
  return { token, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/**
 * Verifies signature, issuer and expiry, in that order.
 *
 * The algorithm is checked against HS256 explicitly: accepting whatever the header
 * names is how `alg: none` and algorithm-confusion attacks get in.
 */
export function verifyAccessToken(
  token: string,
  settings: TokenSettings,
  now: number = Date.now(),
): AccessTokenClaims {
  if (!settings.secret) throw new TokenError('Token secret is not configured');
  if (typeof token !== 'string') throw new TokenError('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Malformed token');
  const [head, body, signature] = parts as [string, string, string];

  const expected = Buffer.from(sign(`${head}.${body}`, settings.secret));
  const provided = Buffer.from(signature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  )
    throw new TokenError('Invalid token signature');

  let header: { alg?: unknown; typ?: unknown };
  let claims: AccessTokenClaims;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('Malformed token');
  }
  if (header.alg !== 'HS256') throw new TokenError('Unsupported token algorithm');
  if (!claims || typeof claims.sub !== 'string' || !claims.sub)
    throw new TokenError('Token has no subject');
  if (claims.iss !== settings.issuer) throw new TokenError('Unexpected token issuer');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now)
    throw new TokenError('Token has expired');
  return claims;
}

/** Pulls the credential out of `Authorization: Bearer <token>`. */
export function readBearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

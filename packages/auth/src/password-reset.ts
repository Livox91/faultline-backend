import { createHash, randomBytes } from 'node:crypto';

/**
 * Password-reset credentials are opaque rather than self-contained tokens.
 *
 * The plaintext is sent once in the email. Only its SHA-256 digest is persisted, so
 * a database read cannot be turned into a working reset link. Thirty-two random bytes
 * provide 256 bits of entropy and need no user-readable formatting.
 */
export function generatePasswordResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

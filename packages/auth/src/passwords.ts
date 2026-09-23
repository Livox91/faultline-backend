import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password storage, on Node's own primitives.
 *
 * scrypt is used rather than a native argon2/bcrypt addon so the platform keeps
 * building without a toolchain, and because the parameters are recorded in the hash
 * itself: raising the cost later re-encodes new passwords without invalidating old
 * ones. Nothing here is reachable when identity comes from an external IdP - those
 * users simply have no stored hash.
 */
const DEFAULTS = { N: 16384, r: 8, p: 1, keyLength: 64 } as const;
const MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12)
    throw new Error('Password must be at least 12 characters');
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, DEFAULTS.keyLength, {
    N: DEFAULTS.N,
    r: DEFAULTS.r,
    p: DEFAULTS.p,
    maxmem: MAX_MEMORY,
  });
  return [
    'scrypt',
    DEFAULTS.N,
    DEFAULTS.r,
    DEFAULTS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification.
 *
 * Returns false for a malformed or absent hash instead of throwing: a user row with no
 * password is an external-identity user, and a login attempt against one is a failed
 * login, not a server error.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (typeof password !== 'string' || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p))
    return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

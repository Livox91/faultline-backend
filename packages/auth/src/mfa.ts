import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const ENROLLMENT_TTL_SECONDS = 10 * 60;

export class MfaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MfaError';
  }
}

function keyFor(masterSecret: string, purpose: string): Buffer {
  if (!masterSecret) throw new MfaError('MFA encryption key is not configured');
  return createHash('sha256')
    .update(`faultline:mfa:${purpose}:v1\0`, 'utf8')
    .update(masterSecret, 'utf8')
    .digest();
}

function base32Encode(value: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let result = '';
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return result;
}

function base32Decode(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[=\s-]/g, '');
  if (!normalized || [...normalized].some((character) => !BASE32_ALPHABET.includes(character)))
    throw new MfaError('Invalid authenticator secret');
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function generateMfaSecret(): string {
  return base32Encode(randomBytes(20));
}

export function authenticatorUri(input: {
  secret: string;
  issuer: string;
  account: string;
}): string {
  const issuer = input.issuer.trim() || 'Faultline';
  const label = encodeURIComponent(`${issuer}:${input.account}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(input.secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

function hotp(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function currentTotpCounter(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/** Returns the accepted counter so the repository can reject replay of the same code. */
export function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
  window = 1,
): number | undefined {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return undefined;
  const provided = Buffer.from(normalized);
  const current = currentTotpCounter(now);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    const expected = Buffer.from(hotp(secret, counter));
    if (expected.length === provided.length && timingSafeEqual(expected, provided))
      return counter;
  }
  return undefined;
}

export function encryptMfaSecret(secret: string, masterSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(masterSecret, 'storage'), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptMfaSecret(value: string, masterSecret: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext)
    throw new MfaError('Stored authenticator secret is invalid');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFor(masterSecret, 'storage'),
      Buffer.from(encodedIv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new MfaError('Stored authenticator secret cannot be decrypted');
  }
}

export function generateRecoveryCodes(count = 10): readonly string[] {
  return Object.freeze(
    Array.from({ length: count }, () =>
      randomBytes(8)
        .toString('hex')
        .toUpperCase()
        .replace(/(.{4})(?=.)/g, '$1-'),
    ),
  );
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code: string, masterSecret: string): string {
  return createHmac('sha256', keyFor(masterSecret, 'recovery'))
    .update(normalizeRecoveryCode(code), 'utf8')
    .digest('base64url');
}

export function recoveryCodeMatches(
  code: string,
  hashes: readonly string[],
  masterSecret: string,
): string | undefined {
  if (!/^[A-Za-z0-9-]{16,24}$/.test(code)) return undefined;
  const candidate = Buffer.from(hashRecoveryCode(code, masterSecret));
  return hashes.find((stored) => {
    const expected = Buffer.from(stored);
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  });
}

interface SignedPayload {
  sub: string;
  exp: number;
  purpose: 'login' | 'enrollment';
  challengeId?: string;
  secret?: string;
}

function signPayload(prefix: string, payload: SignedPayload, masterSecret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', keyFor(masterSecret, 'tokens'))
    .update(`${prefix}.${encoded}`)
    .digest('base64url');
  return `${prefix}.${encoded}.${signature}`;
}

function verifyPayload(
  token: string,
  prefix: string,
  purpose: SignedPayload['purpose'],
  masterSecret: string,
  now = Date.now(),
): SignedPayload {
  const [actualPrefix, encoded, signature] = token.split('.');
  if (actualPrefix !== prefix || !encoded || !signature) throw new MfaError('Invalid MFA token');
  const expected = createHmac('sha256', keyFor(masterSecret, 'tokens'))
    .update(`${prefix}.${encoded}`)
    .digest();
  const provided = Buffer.from(signature, 'base64url');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided))
    throw new MfaError('Invalid MFA token');
  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new MfaError('Invalid MFA token');
  }
  if (
    payload?.purpose !== purpose ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof payload.exp !== 'number' ||
    payload.exp * 1000 <= now
  )
    throw new MfaError('Invalid or expired MFA token');
  return payload;
}

export function issueMfaChallengeToken(
  userId: string,
  challengeId: string,
  masterSecret: string,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS;
  return {
    token: signPayload('mfa1', { sub: userId, challengeId, purpose: 'login', exp }, masterSecret),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyMfaChallengeToken(token: string, masterSecret: string, now = Date.now()) {
  const payload = verifyPayload(token, 'mfa1', 'login', masterSecret, now);
  if (!payload.challengeId) throw new MfaError('Invalid MFA token');
  return { userId: payload.sub, challengeId: payload.challengeId, expiresAt: payload.exp };
}

export function issueMfaEnrollmentToken(
  userId: string,
  encryptedSecret: string,
  challengeId: string,
  masterSecret: string,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + ENROLLMENT_TTL_SECONDS;
  return {
    token: signPayload(
      'mfae1',
      { sub: userId, secret: encryptedSecret, challengeId, purpose: 'enrollment', exp },
      masterSecret,
    ),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyMfaEnrollmentToken(token: string, masterSecret: string, now = Date.now()) {
  const payload = verifyPayload(token, 'mfae1', 'enrollment', masterSecret, now);
  if (!payload.secret || !payload.challengeId)
    throw new MfaError('Invalid MFA enrollment token');
  return {
    userId: payload.sub,
    encryptedSecret: payload.secret,
    challengeId: payload.challengeId,
    expiresAt: payload.exp,
  };
}

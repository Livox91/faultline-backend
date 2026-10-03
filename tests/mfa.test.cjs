const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const {
  InMemoryProjectAssignmentRepository,
  InMemoryUserRepository,
  ROLES,
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  issueMfaChallengeToken,
  recoveryCodeMatches,
  verifyAccessToken,
  verifyMfaChallengeToken,
  verifyTotp,
} = require('../packages/auth/dist');
const { AuthController, LoginThrottle } = require('../apps/api/dist/auth/auth.controller');
const { MfaController } = require('../apps/api/dist/auth/mfa.controller');
const { AuthorizationGuard } = require('../apps/api/dist/auth/authorization.guard');
const { MFA_ENROLLMENT_EXEMPT } = require('../apps/api/dist/auth/context');

const masterSecret = 'mfa-test-master-secret-that-is-at-least-32-characters';
const jwtSecret = 'jwt-test-signing-secret-that-is-distinct-and-long-enough';
const config = {
  applicationName: 'Faultline Test',
  auth: {
    jwtSecret,
    mfaEncryptionKey: masterSecret,
    issuer: 'faultline-test',
    accessTokenTtlSeconds: 3600,
    mfaRequired: false,
  },
};

const request = () => ({ headers: {}, ip: '127.0.0.1', method: 'POST', url: '/test' });

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of value.replace(/=|\s|-/g, '').toUpperCase()) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

function totp(secret, now = Date.now()) {
  const counter = Math.floor(now / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest.at(-1) & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, '0');
}

test('TOTP follows RFC 6238 and accepts only the configured clock window', () => {
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(verifyTotp(rfcSecret, '287082', 59_000), 1);
  assert.equal(verifyTotp(rfcSecret, '287082', 150_000), undefined);
  assert.equal(verifyTotp(rfcSecret, 'not-a-code', 59_000), undefined);
});

test('MFA secrets are encrypted with authenticated encryption', () => {
  const secret = generateMfaSecret();
  const encrypted = encryptMfaSecret(secret, masterSecret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptMfaSecret(encrypted, masterSecret), secret);
  assert.throws(
    () => decryptMfaSecret(encrypted.slice(0, -1) + 'A', masterSecret),
    /cannot be decrypted/,
  );
});

test('challenge tokens are purpose-bound, signed and expire', () => {
  const issued = issueMfaChallengeToken('user-1', 'challenge-1', masterSecret, 1_000);
  assert.deepEqual(verifyMfaChallengeToken(issued.token, masterSecret, 2_000), {
    userId: 'user-1',
    challengeId: 'challenge-1',
    expiresAt: 301,
  });
  assert.throws(() => verifyMfaChallengeToken(issued.token, masterSecret, 302_000));
  assert.throws(() => verifyMfaChallengeToken(issued.token + 'x', masterSecret, 2_000));
});

test('recovery codes are stored as keyed digests and match normalized input', () => {
  const [code] = generateRecoveryCodes(1);
  const hash = hashRecoveryCode(code, masterSecret);
  assert.notEqual(hash, code);
  assert.equal(recoveryCodeMatches(code.toLowerCase(), [hash], masterSecret), hash);
  assert.equal(recoveryCodeMatches('AAAA-BBBB-CCCC-DDDD', [hash], masterSecret), undefined);
});

test('enrollment creates a real factor and login requires a one-time second factor', async () => {
  const users = new InMemoryUserRepository();
  const assignments = new InMemoryProjectAssignmentRepository();
  const auditEntries = [];
  const audit = { record: async (entry) => auditEntries.push(entry) };
  const throttle = new LoginThrottle();
  const auth = new AuthController(users, assignments, config, audit, throttle);
  const mfa = new MfaController(users, assignments, config, audit, throttle);
  const password = 'Correct-horse-battery1!';
  const stored = await users.create({
    organizationId: 'org-1',
    email: 'owner@example.com',
    name: 'Owner',
    role: ROLES.ADMIN,
    password,
  });
  const principal = {
    id: stored.id,
    organizationId: stored.organizationId,
    email: stored.email,
    username: stored.username,
    name: stored.name,
    role: stored.role,
    status: stored.status,
    mfaEnabled: false,
    mustChangePassword: false,
    assignments: [],
  };

  const enrollment = await mfa.startEnrollment(
    principal,
    { currentPassword: password },
    request(),
  );
  const completed = await mfa.finishEnrollment(
    principal,
    { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
    request(),
  );
  assert.equal(completed.enabled, true);
  assert.equal(completed.recoveryCodes.length, 10);
  assert.equal((await users.findById(stored.id)).mfaEnabled, true);
  await assert.rejects(
    mfa.finishEnrollment(
      principal,
      { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) },
      request(),
    ),
    /Invalid or expired MFA enrollment/,
  );

  const firstStep = await auth.login(
    { email: stored.email, password },
    request(),
  );
  assert.equal(firstStep.mfaRequired, true);
  assert.equal(firstStep.accessToken, undefined);

  const session = await mfa.verifyLogin(
    { challengeToken: firstStep.challengeToken, code: completed.recoveryCodes[0] },
    request(),
  );
  assert.ok(session.accessToken);
  assert.deepEqual(
    verifyAccessToken(session.accessToken, {
      secret: jwtSecret,
      issuer: config.auth.issuer,
      ttlSeconds: 3600,
    }).amr,
    ['pwd', 'recovery'],
  );
  assert.equal((await users.findById(stored.id)).mfaRecoveryCodeHashes.length, 9);

  await assert.rejects(
    mfa.verifyLogin(
      { challengeToken: firstStep.challengeToken, code: completed.recoveryCodes[0] },
      request(),
    ),
    /Invalid authenticator or recovery code|Invalid or expired MFA challenge/,
  );
  assert.ok(auditEntries.some((entry) => entry.action === 'auth.mfa.enabled'));
});

test('mandatory MFA is enforced by the backend until enrollment, not only by React', async () => {
  const principal = {
    id: '9b7646a2-8377-4aaf-8f7c-99366ac15119',
    organizationId: 'org-1',
    email: 'owner@example.com',
    username: null,
    name: 'Owner',
    role: ROLES.ADMIN,
    status: 'active',
    mfaEnabled: false,
    mfaEnrollmentRequired: true,
    mustChangePassword: false,
    assignments: [],
  };
  const requestWithUser = {
    ...request(),
    user: principal,
    originalUrl: '/clusters',
  };
  const context = {
    getHandler: () => 'handler',
    getClass: () => 'controller',
    switchToHttp: () => ({ getRequest: () => requestWithUser }),
  };
  const audit = { record: async () => undefined };
  const lockedReflector = { getAllAndOverride: () => undefined };
  await assert.rejects(
    new AuthorizationGuard(lockedReflector, audit).canActivate(context),
    /enroll multi-factor authentication/,
  );

  const enrollmentReflector = {
    getAllAndOverride: (key) => key === MFA_ENROLLMENT_EXEMPT ? true : undefined,
  };
  assert.equal(
    await new AuthorizationGuard(enrollmentReflector, audit).canActivate(context),
    true,
  );
});

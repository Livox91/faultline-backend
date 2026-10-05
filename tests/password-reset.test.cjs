const test = require('node:test');
const assert = require('node:assert/strict');

const {
  InMemoryProjectAssignmentRepository,
  InMemoryUserRepository,
  ROLES,
  issueAccessToken,
  verifyPassword,
} = require('../packages/auth/dist');
const { RecordingEmailSender } = require('../packages/email/dist');
const {
  PasswordResetController,
  PasswordResetThrottle,
} = require('../apps/api/dist/auth/password-reset.controller');
const { AuthController, LoginThrottle } = require('../apps/api/dist/auth/auth.controller');
const { AuthenticationGuard } = require('../apps/api/dist/auth/authentication.guard');
const { AuthSecurityStore } = require('../apps/api/dist/auth/security-store');

const jwtSecret = 'password-reset-test-jwt-secret-that-is-long-enough';
const config = {
  applicationName: 'Faultline Test',
  environment: 'test',
  publicUrl: 'http://localhost:5173',
  auth: {
    jwtSecret,
    issuer: 'faultline-test',
    accessTokenTtlSeconds: 3600,
    passwordResetTtlSeconds: 1800,
    mfaRequired: false,
  },
};

const request = () => ({
  headers: { 'user-agent': 'test' },
  ip: '127.0.0.1',
  method: 'POST',
  url: '/auth/forgot-password',
});
const response = () => ({ append() {} });

function resetToken(message) {
  const link = message.text.match(/http:\/\/localhost:5173\/reset-password\?token=([^\s]+)/);
  assert.ok(link, 'email must contain a reset link');
  return decodeURIComponent(link[1]);
}

test('forgot-password is non-enumerating and sends a single-use expiring link', async () => {
  const users = new InMemoryUserRepository();
  const email = new RecordingEmailSender();
  const auditEntries = [];
  const audit = { record: async (entry) => auditEntries.push(entry) };
  const controller = new PasswordResetController(
    users,
    email,
    config,
    audit,
    new PasswordResetThrottle(),
  );
  const user = await users.create({
    email: 'owner@example.com',
    name: 'Owner',
    role: ROLES.ADMIN,
    password: 'Original-password1!',
  });

  const unknown = await controller.forgotPassword(
    { email: 'missing@example.com' },
    request(),
  );
  const known = await controller.forgotPassword(
    { email: 'OWNER@example.com' },
    request(),
  );
  assert.deepEqual(unknown, known);
  assert.equal(email.sent.length, 1);
  assert.doesNotMatch(email.sent[0].text, /original password phrase/);

  const token = resetToken(email.sent[0]);
  const staleMfaChallenge = await users.createMfaChallenge(
    user.id,
    new Date(Date.now() + 300_000).toISOString(),
  );
  await assert.rejects(
    controller.resetPassword(
      { token, newPassword: 'all-lowercase-password1!' },
      request(),
    ),
    /uppercase letter/i,
  );
  await assert.rejects(
    controller.resetPassword(
      { token, newPassword: 'Original-password1!' },
      request(),
    ),
    /different from the current password/i,
  );
  await controller.resetPassword(
    { token, newPassword: 'A-new-secure-password2!' },
    request(),
  );
  const updated = await users.findById(user.id);
  assert.equal(await verifyPassword('Original-password1!', updated.passwordHash), false);
  assert.equal(await verifyPassword('A-new-secure-password2!', updated.passwordHash), true);
  assert.equal(updated.sessionVersion, 2);
  assert.equal(await users.consumeMfaChallenge(staleMfaChallenge, user.id), false);
  await assert.rejects(
    controller.resetPassword(
      { token, newPassword: 'Another-secure-password3!' },
      request(),
    ),
    /invalid or has expired/i,
  );
  assert.ok(auditEntries.some((entry) => entry.action === 'auth.password-reset.requested'));
  assert.ok(auditEntries.some((entry) => entry.action === 'auth.password-reset.completed'));
});

test('requesting a newer link invalidates the previous reset link', async () => {
  const users = new InMemoryUserRepository();
  const email = new RecordingEmailSender();
  const controller = new PasswordResetController(
    users,
    email,
    config,
    { record: async () => undefined },
    new PasswordResetThrottle(),
  );
  await users.create({
    email: 'owner@example.com',
    name: 'Owner',
    role: ROLES.ADMIN,
    password: 'Original-password1!',
  });
  await controller.forgotPassword({ email: 'owner@example.com' }, request());
  const first = resetToken(email.sent[0]);
  await controller.forgotPassword({ email: 'owner@example.com' }, request());
  const second = resetToken(email.sent[1]);

  await assert.rejects(
    controller.resetPassword(
      { token: first, newPassword: 'A-new-secure-password2!' },
      request(),
    ),
    /invalid or has expired/i,
  );
  await controller.resetPassword(
    { token: second, newPassword: 'A-new-secure-password2!' },
    request(),
  );
});

test('a successful reset revokes old JWTs and the new password can sign in', async () => {
  const users = new InMemoryUserRepository();
  const assignments = new InMemoryProjectAssignmentRepository();
  const email = new RecordingEmailSender();
  const audit = { record: async () => undefined };
  const security = new AuthSecurityStore(config);
  const controller = new PasswordResetController(
    users,
    email,
    config,
    audit,
    new PasswordResetThrottle(),
  );
  const user = await users.create({
    email: 'owner@example.com',
    name: 'Owner',
    role: ROLES.ADMIN,
    password: 'Original-password1!',
  });
  const oldSession = issueAccessToken(
    { sub: user.id, email: user.email, role: user.role, sv: user.sessionVersion },
    { secret: jwtSecret, issuer: config.auth.issuer, ttlSeconds: 3600 },
  );
  const oldToken = oldSession.token;
  await security.createSession(oldSession.sessionId, user.id, 3600);
  await controller.forgotPassword({ email: user.email }, request());
  await controller.resetPassword(
    {
      token: resetToken(email.sent[0]),
      newPassword: 'A-new-secure-password2!',
    },
    request(),
  );

  const guardedRequest = {
    ...request(),
    headers: { authorization: `Bearer ${oldToken}` },
  };
  const context = {
    getHandler: () => 'handler',
    getClass: () => 'controller',
    switchToHttp: () => ({ getRequest: () => guardedRequest }),
  };
  const reflector = { getAllAndOverride: () => undefined };
  await assert.rejects(
    new AuthenticationGuard(reflector, users, assignments, config, security).canActivate(context),
    /Invalid or expired credentials/,
  );

  const auth = new AuthController(
    users,
    assignments,
    config,
    audit,
    new LoginThrottle(security),
    security,
  );
  await assert.rejects(
    auth.login(
      { email: user.email, password: 'Original-password1!' },
      request(),
      response(),
    ),
    /Invalid email or password/,
  );
  const session = await auth.login(
    { email: user.email, password: 'A-new-secure-password2!' },
    request(),
    response(),
  );
  assert.ok(session.accessToken);
});

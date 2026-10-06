require('reflect-metadata');

const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const {
  AUDIT_ACTIONS,
  InMemoryProjectAssignmentRepository,
  InMemoryUserRepository,
  ROLES,
  isRole,
  parseRole,
} = require('@faultline/auth');
const {
  InMemoryContactRepository,
  InMemorySlackIntegrationRepository,
} = require('@faultline/notifications');
const { AuthController } = require('../apps/api/dist/auth/auth.controller');

const PASSWORD = 'Correct-horse-battery-7!';
const request = {
  headers: { 'user-agent': 'faultline-security-test' },
  socket: { remoteAddress: '127.0.0.1' },
};

function apiConfig(auth = {}) {
  return {
    application: 'api',
    applicationName: 'Faultline Test',
    environment: 'test',
    version: '0.1.0-test',
    auth: {
      jwtSecret: 'test-secret-that-is-long-enough-to-sign-with',
      issuer: 'faultline-test',
      accessTokenTtlSeconds: 3600,
      mfaRequired: false,
      ...auth,
    },
  };
}

function responseSpy() {
  const cookies = [];
  return {
    cookies,
    cookie(...args) {
      cookies.push(args);
    },
    clearCookie(...args) {
      cookies.push(args);
    },
  };
}

async function authenticationHarness(auth = {}) {
  const users = new InMemoryUserRepository();
  const assignments = new InMemoryProjectAssignmentRepository();
  const audit = [];
  const sessions = [];
  const throttle = {
    checked: [],
    failed: [],
    succeeded: [],
    async check(key) {
      this.checked.push(key);
    },
    async fail(key) {
      this.failed.push(key);
    },
    async succeed(key) {
      this.succeeded.push(key);
    },
  };
  const security = {
    async createSession(...args) {
      sessions.push(args);
    },
    async revokeSession() {},
    async revokeAllSessions() {},
  };
  const controller = new AuthController(
    users,
    assignments,
    apiConfig(auth),
    {
      async record(entry) {
        audit.push(entry);
      },
    },
    throttle,
    security,
  );
  return { users, assignments, audit, sessions, throttle, controller };
}

test('MFA-enabled accounts fail closed before a session or cookie is issued', async () => {
  const harness = await authenticationHarness({ mfaRequired: true });
  const user = await harness.users.create({
    email: 'mfa@faultline.test',
    name: 'MFA User',
    role: ROLES.ADMIN,
    password: PASSWORD,
    mfaEnabled: true,
  });
  if (!user.mfaEnabled && typeof harness.users.configureMfa === 'function')
    await harness.users.configureMfa(
      user.id,
      'test-encrypted-mfa-secret',
      ['test-recovery-hash'],
      null,
    );
  const response = responseSpy();

  let challenge;
  try {
    challenge = await harness.controller.login(
      { email: 'mfa@faultline.test', password: PASSWORD },
      request,
      response,
    );
  } catch (error) {
    // The lightweight deployment has no factor provider and deliberately stops here.
    assert.equal(error?.getStatus?.(), 503);
    assert.match(error.message, /second factor/i);
  }

  if (challenge) {
    // Deployments with the MFA module return only a short-lived challenge. They must
    // never mint the ordinary access token at the password-only stage.
    assert.equal(challenge.mfaRequired, true);
    assert.equal(typeof challenge.challengeToken, 'string');
    assert.equal('accessToken' in challenge, false);
  }

  assert.equal(harness.sessions.length, 0, 'MFA must precede session creation');
  assert.equal(response.cookies.length, 0, 'MFA must precede cookie issuance');
  assert.deepEqual(harness.throttle.succeeded, ['mfa@faultline.test']);
  assert.equal(harness.audit.length, 1);
  assert.equal(harness.audit[0].action, AUDIT_ACTIONS.LOGIN_SUCCEEDED);
  assert.deepEqual(harness.audit[0].metadata, {
    stage: 'password',
    mfaPending: true,
  });
});

test('external-identity accounts cannot fall back to a local password', async () => {
  const harness = await authenticationHarness();
  const external = await harness.users.create({
    email: 'sso@faultline.test',
    name: 'SSO User',
    role: ROLES.ONSITE_ENGINEER,
    externalSubject: 'oidc|faultline|123',
  });
  assert.equal(
    (await harness.users.findByExternalSubject('oidc|faultline|123')).id,
    external.id,
  );

  await assert.rejects(
    harness.controller.login(
      { email: external.email, password: PASSWORD },
      request,
      responseSpy(),
    ),
    (error) => error?.getStatus?.() === 401,
  );

  assert.equal(harness.sessions.length, 0);
  assert.deepEqual(harness.throttle.failed, [external.email]);
  assert.equal(harness.audit[0].action, AUDIT_ACTIONS.LOGIN_FAILED);
  assert.equal(harness.audit[0].outcome, 'denied');
  assert.equal(harness.audit[0].metadata.reason, 'bad_password');
});

test('unimplemented agent autonomy identities fail closed at the role boundary', () => {
  for (const role of ['agent', 'read-only-agent', 'suggestive', 'autonomous']) {
    assert.equal(isRole(role), false);
    assert.equal(parseRole(role), undefined);
  }
  assert.deepEqual(
    new Set([ROLES.ADMIN, ROLES.ONSITE_ENGINEER]),
    new Set(['admin', 'onsiteengineer']),
  );
});

test('approval and autonomous execution routes remain closed until their policy engine exists', () => {
  const apiSource = join(process.cwd(), 'apps/api/src');
  const controllerSurface = readdirSync(apiSource, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.controller.ts'))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');

  // Until the policy and approval state machines exist, exposing either mutation
  // route would create an ungoverned remediation path.
  assert.doesNotMatch(
    controllerSurface,
    /@(Post|Put|Patch)\([^)]*(approve|remediat|autonom|execute)/i,
  );
  const vocabulary = readFileSync(
    join(process.cwd(), 'packages/auth/src/audit.ts'),
    'utf8',
  );
  assert.match(vocabulary, /REMEDIATION_APPROVED:\s*'remediation\.approved'/);
  assert.match(vocabulary, /REMEDIATION_EXECUTED:\s*'remediation\.executed'/);
});

test('tenant-scoped notification repositories do not mix organizations', async () => {
  const contacts = new InMemoryContactRepository();
  const slack = new InMemorySlackIntegrationRepository();
  const now = '2026-10-04T00:00:00.000Z';

  for (const organizationId of ['tenant-a', 'tenant-b']) {
    await contacts.create({
      id: `contact-${organizationId}`,
      organizationId,
      name: organizationId,
      role: 'ENGINEER',
      phoneNumber:
        organizationId === 'tenant-a' ? '+15550000001' : '+15550000002',
      smsEnabled: true,
      voiceEnabled: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await slack.upsert(organizationId, {
      enabled: true,
      incidentChannelId: organizationId === 'tenant-a' ? 'CA' : 'CB',
    });
  }

  assert.deepEqual(
    (await contacts.list('tenant-a')).map((value) => value.id),
    ['contact-tenant-a'],
  );
  assert.deepEqual(
    (await contacts.list('tenant-b')).map((value) => value.id),
    ['contact-tenant-b'],
  );

  assert.equal((await slack.get('tenant-a')).incidentChannelId, 'CA');
  assert.equal((await slack.get('tenant-b')).incidentChannelId, 'CB');
});

test('every implemented high-risk action is wired to the central audit trail', () => {
  const coverage = {
    'apps/api/src/auth/auth.controller.ts': [
      'LOGIN_SUCCEEDED',
      'LOGIN_FAILED',
      'LOGOUT',
      'PASSWORD_CHANGED',
    ],
    'apps/api/src/auth/authorization.guard.ts': ['ACCESS_DENIED'],
    'apps/api/src/auth/users.controller.ts': [
      'SESSIONS_REVOKED',
      'USER_CREATED',
      'USER_MODIFIED',
      'PERMISSION_CHANGED',
      'PROJECT_ASSIGNED',
      'PROJECT_ASSIGNMENT_REMOVED',
    ],
    'apps/api/src/clusters.controller.ts': [
      'PROJECT_CREATED',
      'PROJECT_MODIFIED',
      'PROJECT_DELETED',
    ],
    'apps/api/src/billing/provisioning.service.ts': [
      'SUBSCRIPTION_PURCHASED',
      'SUBSCRIPTION_PROVISIONED',
      'SUBSCRIPTION_PROVISIONING_FAILED',
    ],
    'apps/api/src/incident-report.controller.ts': ['REPORT_EXPORTED'],
    'apps/api/src/incident-acknowledgement.controller.ts': [
      'INCIDENT_ACKNOWLEDGED',
    ],
    'apps/api/src/incident-external-ticket.controller.ts': [
      'SLACK_TICKET_REQUESTED',
    ],
    'apps/api/src/slack-integration.controller.ts': [
      'SLACK_CONFIGURATION_CHANGED',
    ],
    'apps/api/src/notification-management.controller.ts': [
      'CONTACT_CREATED',
      'CONTACT_UPDATED',
      'NOTIFICATION_GROUP_CREATED',
    ],
    'apps/api/src/on-call.controller.ts': [
      'ON_CALL_SCHEDULE_CREATED',
      'ON_CALL_SCHEDULE_UPDATED',
      'ON_CALL_SHIFT_CREATED',
      'AVAILABILITY_OVERRIDE_CREATED',
    ],
  };
  const vocabulary = readFileSync(
    join(process.cwd(), 'packages/auth/src/audit.ts'),
    'utf8',
  );

  for (const [relativePath, names] of Object.entries(coverage)) {
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
    for (const name of names) {
      assert.match(
        vocabulary,
        new RegExp(`\\b${name}:\\s*'[^']+'`),
        `${name} must be defined in the central audit vocabulary`,
      );
      assert.match(
        source,
        new RegExp(`AUDIT_ACTIONS\\.${name}\\b`),
        `${relativePath} must record ${name}`,
      );
    }
  }
});

test('every authenticated request is covered by the global activity audit interceptor', () => {
  const moduleSource = readFileSync(
    join(process.cwd(), 'apps/api/src/app.module.ts'),
    'utf8',
  );
  const interceptorSource = readFileSync(
    join(
      process.cwd(),
      'apps/api/src/auth/user-activity-audit.interceptor.ts',
    ),
    'utf8',
  );
  assert.match(moduleSource, /APP_INTERCEPTOR[\s\S]*UserActivityAuditInterceptor/);
  assert.match(interceptorSource, /AUDIT_ACTIONS\.USER_ACTIVITY/);
  assert.match(interceptorSource, /request\.user/);
  assert.doesNotMatch(interceptorSource, /request\.body|request\.query/);
});

test.todo(
  'external identity callback validates issuer, audience, nonce and maps the subject before issuing a session',
);
test.todo(
  'suggestive agents require a human approval while autonomous agents remain inside configured action bounds',
);
test.todo(
  'approval decisions are authorized, single-use, expire safely and are audited before remediation executes',
);

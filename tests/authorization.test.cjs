require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { APPLICATION_CONFIG } = require('@faultline/platform');
const {
  INCIDENT_REPOSITORY,
  InMemoryIncidentRepository,
} = require('@faultline/incidents');
const {
  ROLES,
  hasProjectAccess,
  issueAccessToken,
  verifyAccessToken,
  hashPassword,
  verifyPassword,
} = require('@faultline/auth');
const {
  CLUSTER_DIRECTORY,
  ClustersController,
} = require('../apps/api/dist/clusters.controller');
const {
  IncidentsController,
} = require('../apps/api/dist/incidents.controller');
const {
  AdminUsersController,
} = require('../apps/api/dist/auth/users.controller');
const {
  AdminAuditController,
} = require('../apps/api/dist/auth/audit.controller');
const {
  TELEMETRY_SCOPE_RESOLVER,
  UserTelemetryScopeResolver,
} = require('../apps/api/dist/telemetry-scope');
const {
  ISSUER,
  TOKEN_SECRET,
  apiConfig,
  bootWithRealGuards,
  tokenFor,
} = require('./auth-harness.cjs');

/* ------------------------------------------------------------------ fixtures */

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

const project = (id) => ({
  id,
  name: id,
  environment: 'production',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  total: 0,
  open: 0,
  critical: 0,
  assignedUserIds: [],
});

const projects = new Map([
  [PROJECT_A, project(PROJECT_A)],
  [PROJECT_B, project(PROJECT_B)],
]);

/**
 * A directory that honours the id list it is given.
 *
 * Deliberately not a stub that returns everything: the point of passing the permitted
 * ids into the query is that the filter happens at the source, and a test double that
 * ignored them would let a missing filter pass unnoticed.
 */
const directory = {
  list: async (ids) =>
    [...projects.values()].filter((entry) => !ids || ids.includes(entry.id)),
  get: async (id) => projects.get(id),
  create: async (input) => {
    const created = { ...project(input.id), name: input.name };
    projects.set(input.id, created);
    return created;
  },
  update: async (id, changes) => {
    const existing = projects.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...changes };
    projects.set(id, updated);
    return updated;
  },
  remove: async (id) => projects.delete(id),
};

const incident = (id, clusterId) => ({
  id,
  correlationKey: `key-${id}`,
  clusterId,
  namespace: 'default',
  classification: 'MEMORY_EXHAUSTION',
  title: id,
  summary: id,
  severity: 'HIGH',
  status: 'OPEN',
  confidence: 0.9,
  firstSeen: '2026-09-10T00:00:00.000Z',
  lastSeen: '2026-09-10T00:05:00.000Z',
  primaryResource: { scope: 'pod', clusterId, namespace: 'default', pod: 'p-1' },
  affectedResources: [],
  anomalies: [{ anomalyId: `anomaly-${id}` }],
  evidence: [],
  timeline: [],
});

/** Boots the whole authorized surface on in-memory storage. */
async function boot() {
  const incidents = new InMemoryIncidentRepository();
  await incidents.createIncident(incident('incident-a', PROJECT_A));
  await incidents.createIncident(incident('incident-b', PROJECT_B));

  const config = apiConfig();
  const context = await bootWithRealGuards({
    controllers: [
      ClustersController,
      IncidentsController,
      AdminUsersController,
      AdminAuditController,
    ],
    providers: [
      { provide: CLUSTER_DIRECTORY, useValue: directory },
      { provide: INCIDENT_REPOSITORY, useValue: incidents },
      {
        provide: TELEMETRY_SCOPE_RESOLVER,
        useFactory: () => new UserTelemetryScopeResolver(config),
      },
    ],
    config,
  });

  const adminRecord = await context.users.create({
    email: 'admin@faultline.test',
    name: 'Administrator',
    role: ROLES.ADMIN,
    password: 'correct-horse-battery',
  });
  const engineerRecord = await context.users.create({
    email: 'ahmed@faultline.test',
    name: 'Ahmed',
    role: ROLES.ONSITE_ENGINEER,
    password: 'correct-horse-battery',
  });
  await context.assignments.assign(
    engineerRecord.id,
    PROJECT_A,
    adminRecord.id,
    [],
  );

  return {
    ...context,
    incidents,
    adminToken: tokenFor(adminRecord),
    engineerToken: tokenFor(engineerRecord),
    adminRecord,
    engineerRecord,
  };
}

const call = (base, token, path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

/* -------------------------------------------------------------------- tests */

test('the rules themselves: an admin reaches every project, an engineer only assigned ones', () => {
  const admin = { role: ROLES.ADMIN, status: 'active', assignments: [] };
  const engineer = {
    role: ROLES.ONSITE_ENGINEER,
    status: 'active',
    assignments: [{ projectId: PROJECT_A }],
  };
  assert.equal(hasProjectAccess(admin, PROJECT_B), true);
  assert.equal(hasProjectAccess(engineer, PROJECT_A), true);
  assert.equal(hasProjectAccess(engineer, PROJECT_B), false);
  // A disabled account reaches nothing, whatever it is assigned to.
  assert.equal(
    hasProjectAccess({ ...engineer, status: 'disabled' }, PROJECT_A),
    false,
  );
  assert.equal(hasProjectAccess(null, PROJECT_A), false);
});

test('passwords are salted, verified in constant time and never matched by a bad hash', async () => {
  const hash = await hashPassword('correct-horse-battery');
  assert.notEqual(hash, await hashPassword('correct-horse-battery'));
  assert.equal(await verifyPassword('correct-horse-battery', hash), true);
  assert.equal(await verifyPassword('wrong-horse-battery', hash), false);
  // An external-identity user has no hash; a login against one simply fails.
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});

test('a tampered, foreign-issued or expired token is refused', () => {
  const settings = { secret: TOKEN_SECRET, issuer: ISSUER, ttlSeconds: 3600 };
  const { token } = issueAccessToken(
    { sub: 'user-1', email: 'a@b.c', role: ROLES.ADMIN },
    settings,
  );
  assert.equal(verifyAccessToken(token, settings).sub, 'user-1');

  // Claims rewritten to say "admin" do not survive signature verification.
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({
      sub: 'user-1',
      email: 'a@b.c',
      role: ROLES.ADMIN,
      iss: ISSUER,
      iat: 1,
      exp: 2 ** 40,
    }),
  ).toString('base64url');
  assert.throws(
    () => verifyAccessToken(`${header}.${forged}.${signature}`, settings),
    /signature/i,
  );
  assert.throws(
    () => verifyAccessToken(token, { ...settings, secret: 'another-secret-x' }),
    /signature/i,
  );
  assert.throws(
    () => verifyAccessToken(token, { ...settings, issuer: 'someone-else' }),
    /issuer/i,
  );
  const expired = issueAccessToken(
    { sub: 'user-1', email: 'a@b.c', role: ROLES.ADMIN },
    { ...settings, ttlSeconds: 60 },
    Date.now() - 3_600_000,
  ).token;
  assert.throws(() => verifyAccessToken(expired, settings), /expired/i);
});

test('an anonymous caller reaches nothing', async () => {
  const { app, base } = await boot();
  try {
    for (const path of [
      '/projects',
      `/projects/${PROJECT_A}`,
      '/incidents',
      '/incidents/incident-a',
      '/admin/users',
      '/admin/audit',
    ]) {
      const response = await call(base, null, path);
      assert.equal(response.status, 401, `${path} must refuse anonymous callers`);
    }
    // A syntactically valid but unsigned token is no better than none.
    assert.equal((await call(base, 'not-a-token', '/projects')).status, 401);
  } finally {
    await app.close();
  }
});

test('an engineer sees only assigned projects, however the request is phrased', async () => {
  const { app, base, engineerToken, adminToken } = await boot();
  try {
    const listed = await call(base, engineerToken, '/projects');
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (await listed.json()).map((entry) => entry.id),
      [PROJECT_A],
      'project B must not appear in the listing',
    );

    // Scenario 3/4: the URL is edited, or curl is used directly. Both end here.
    const direct = await call(base, engineerToken, `/projects/${PROJECT_B}`);
    assert.equal(direct.status, 403);
    // The alias path is the same resource and the same answer.
    assert.equal(
      (await call(base, engineerToken, `/clusters/${PROJECT_B}`)).status,
      403,
    );
    assert.equal(
      (await call(base, engineerToken, `/projects/${PROJECT_A}`)).status,
      200,
    );

    // The Admin is limited by nothing.
    const adminListed = await call(base, adminToken, '/projects');
    assert.deepEqual(
      (await adminListed.json()).map((entry) => entry.id).sort(),
      [PROJECT_A, PROJECT_B],
    );
    assert.equal(
      (await call(base, adminToken, `/projects/${PROJECT_B}`)).status,
      200,
    );
  } finally {
    await app.close();
  }
});

test('incident reads are bounded by assignment, not by the filter the caller sends', async () => {
  const { app, base, engineerToken, adminToken } = await boot();
  try {
    const listed = await call(base, engineerToken, '/incidents');
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (await listed.json()).map((entry) => entry.id),
      ['incident-a'],
      'an unfiltered listing must still exclude project B',
    );

    // Naming another project in the filter is refused rather than silently emptied.
    assert.equal(
      (await call(base, engineerToken, `/incidents?cluster=${PROJECT_B}`)).status,
      403,
    );

    // An incident id from another project answers 404: its existence is not confirmed.
    assert.equal(
      (await call(base, engineerToken, '/incidents/incident-b')).status,
      404,
    );
    assert.equal(
      (await call(base, engineerToken, '/incidents/incident-a')).status,
      200,
    );

    const adminAll = await call(base, adminToken, '/incidents');
    assert.deepEqual(
      (await adminAll.json()).map((entry) => entry.id).sort(),
      ['incident-a', 'incident-b'],
    );
    assert.equal(
      (await call(base, adminToken, '/incidents/incident-b')).status,
      200,
    );
  } finally {
    await app.close();
  }
});

test('an engineer cannot create, change or delete projects, or manage anyone', async () => {
  const { app, base, engineerToken, engineerRecord } = await boot();
  try {
    const forbidden = [
      ['POST', '/projects', { id: 'project-c', name: 'C' }],
      ['PATCH', `/projects/${PROJECT_A}`, { name: 'renamed' }],
      ['DELETE', `/projects/${PROJECT_A}`, undefined],
      ['GET', '/admin/users', undefined],
      ['POST', '/admin/users', { email: 'x@y.z', name: 'X', role: 'admin', password: 'correct-horse-battery' }],
      ['GET', '/admin/audit', undefined],
      ['PUT', `/admin/users/${engineerRecord.id}/projects/${PROJECT_B}`, {}],
    ];
    for (const [method, path, body] of forbidden) {
      const response = await call(base, engineerToken, path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(
        response.status,
        403,
        `${method} ${path} must be forbidden for an engineer`,
      );
    }
    // Self-assignment did not happen: the refusal was not merely cosmetic.
    const still = await call(base, engineerToken, '/projects');
    assert.deepEqual(
      (await still.json()).map((entry) => entry.id),
      [PROJECT_A],
    );
  } finally {
    await app.close();
  }
});

test('an admin manages users and assignments, and access follows immediately', async () => {
  const { app, base, adminToken, engineerToken, engineerRecord } = await boot();
  try {
    const listed = await call(base, adminToken, '/admin/users');
    assert.equal(listed.status, 200);
    const users = (await listed.json()).items;
    const ahmed = users.find((user) => user.email === 'ahmed@faultline.test');
    assert.deepEqual(ahmed.projectIds, [PROJECT_A]);
    assert.equal(ahmed.role, ROLES.ONSITE_ENGINEER);
    assert.equal(ahmed.passwordHash, undefined, 'no credential is ever returned');
    // An admin is not enumerated against projects: their reach is not a finite list.
    assert.equal(
      users.find((user) => user.role === ROLES.ADMIN).projectIds,
      null,
    );

    // Granting project B takes effect on the engineer's very next request, using the
    // token they already hold: authorization reads storage, not the token's claims.
    assert.equal(
      (await call(base, engineerToken, `/projects/${PROJECT_B}`)).status,
      403,
    );
    const assigned = await call(
      base,
      adminToken,
      `/admin/users/${engineerRecord.id}/projects/${PROJECT_B}`,
      { method: 'PUT', body: JSON.stringify({}) },
    );
    assert.equal(assigned.status, 200);
    assert.equal(
      (await call(base, engineerToken, `/projects/${PROJECT_B}`)).status,
      200,
      'a new assignment applies without re-issuing the token',
    );

    // And revoking it applies just as immediately.
    const removed = await call(
      base,
      adminToken,
      `/admin/users/${engineerRecord.id}/projects/${PROJECT_B}`,
      { method: 'DELETE' },
    );
    assert.equal(removed.status, 204);
    assert.equal(
      (await call(base, engineerToken, `/projects/${PROJECT_B}`)).status,
      403,
      'a revoked assignment applies without waiting for the token to expire',
    );
  } finally {
    await app.close();
  }
});

test('a disabled account loses access while holding a valid token', async () => {
  const { app, base, adminToken, engineerToken, engineerRecord } = await boot();
  try {
    assert.equal((await call(base, engineerToken, '/projects')).status, 200);
    const disabled = await call(
      base,
      adminToken,
      `/admin/users/${engineerRecord.id}`,
      { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) },
    );
    assert.equal(disabled.status, 200);
    assert.equal(
      (await call(base, engineerToken, '/projects')).status,
      401,
      'the token is still well-formed; the account behind it is not usable',
    );
  } finally {
    await app.close();
  }
});

test('an admin cannot lock administration out of the system through themselves', async () => {
  const { app, base, adminToken, adminRecord } = await boot();
  try {
    const demoted = await call(base, adminToken, `/admin/users/${adminRecord.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: ROLES.ONSITE_ENGINEER }),
    });
    assert.equal(demoted.status, 400);
    const disabled = await call(base, adminToken, `/admin/users/${adminRecord.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(disabled.status, 400);
  } finally {
    await app.close();
  }
});

test('refused attempts and permission changes are written to the audit trail', async () => {
  const { app, base, adminToken, engineerToken, engineerRecord, audit } =
    await boot();
  try {
    await call(base, engineerToken, `/projects/${PROJECT_B}`);
    await call(base, engineerToken, '/admin/users');
    await call(
      base,
      adminToken,
      `/admin/users/${engineerRecord.id}/projects/${PROJECT_B}`,
      { method: 'PUT', body: JSON.stringify({}) },
    );

    const denials = await audit.list({ outcome: 'denied' });
    assert.ok(
      denials.some(
        (entry) =>
          entry.resourceType === 'project' && entry.resourceId === PROJECT_B,
      ),
      'the unauthorized project access attempt is recorded',
    );
    assert.ok(
      denials.some((entry) => entry.metadata.check === 'role'),
      'the refused admin route is recorded',
    );
    for (const entry of denials) {
      assert.equal(entry.action, 'access.denied');
      assert.equal(entry.actor, 'ahmed@faultline.test');
    }

    const grants = await audit.list({ action: 'project.assignment.created' });
    assert.equal(grants.length, 1);
    assert.equal(grants[0].resourceId, PROJECT_B);
    assert.equal(grants[0].outcome, 'allowed');
    assert.equal(grants[0].actor, 'admin@faultline.test');

    // The trail is append-only: the repository exposes no way to alter it.
    assert.equal(typeof audit.update, 'undefined');
    assert.equal(typeof audit.delete, 'undefined');
  } finally {
    await app.close();
  }
});

test('the telemetry scope intersects the deployment scope with the caller assignments', async () => {
  const scoped = new UserTelemetryScopeResolver(
    apiConfig({ queryClusterScope: [PROJECT_A, PROJECT_B] }),
  );
  const admin = { role: ROLES.ADMIN, status: 'active', assignments: [] };
  const engineer = {
    role: ROLES.ONSITE_ENGINEER,
    status: 'active',
    assignments: [{ projectId: PROJECT_A }],
  };

  assert.deepEqual(await scoped.resolve(admin), {
    mode: 'clusters',
    clusterIds: [PROJECT_A, PROJECT_B],
  });
  assert.deepEqual(await scoped.resolve(engineer), {
    mode: 'clusters',
    clusterIds: [PROJECT_A],
  });

  // An assignment to something this deployment may not read grants nothing.
  assert.deepEqual(
    await scoped.resolve({
      ...engineer,
      assignments: [{ projectId: 'somewhere-else' }],
    }),
    { mode: 'clusters', clusterIds: [] },
  );

  // An engineer with no assignments gets the empty scope, never the wide one - even in
  // development, where an Admin would get "all clusters".
  const development = new UserTelemetryScopeResolver(apiConfig());
  assert.deepEqual(await development.resolve(admin), {
    mode: 'all-development-clusters',
  });
  assert.deepEqual(
    await development.resolve({ ...engineer, assignments: [] }),
    { mode: 'clusters', clusterIds: [] },
  );
});

test('login issues a token that the guards accept, and refuses everything else', async () => {
  const {
    AuthController,
    LoginThrottle,
  } = require('../apps/api/dist/auth/auth.controller');

  const config = apiConfig();
  const context = await bootWithRealGuards({
    controllers: [AuthController, ClustersController],
    providers: [
      { provide: CLUSTER_DIRECTORY, useValue: directory },
      LoginThrottle,
    ],
    config,
  });
  const { app, base, users, assignments, audit } = context;
  try {
    const admin = await users.create({
      email: 'boss@faultline.test',
      name: 'Boss',
      role: ROLES.ADMIN,
      password: 'correct-horse-battery',
    });
    const ahmed = await users.create({
      email: 'ahmed2@faultline.test',
      name: 'Ahmed',
      role: ROLES.ONSITE_ENGINEER,
      password: 'correct-horse-battery',
    });
    await assignments.assign(ahmed.id, PROJECT_A, admin.id, []);

    const login = (body) =>
      fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // A wrong password and an unknown account are indistinguishable to the caller.
    const wrong = await login({
      email: 'boss@faultline.test',
      password: 'nope-nope-nope',
    });
    const unknown = await login({
      email: 'nobody@faultline.test',
      password: 'nope-nope-nope',
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal((await wrong.json()).message, (await unknown.json()).message);

    const ok = await login({
      email: 'ahmed2@faultline.test',
      password: 'correct-horse-battery',
    });
    assert.equal(ok.status, 200);
    const session = await ok.json();
    assert.ok(session.accessToken);
    assert.equal(session.user.role, ROLES.ONSITE_ENGINEER);
    assert.deepEqual(session.user.projectIds, [PROJECT_A]);
    assert.equal(session.user.passwordHash, undefined);

    // The issued token is a real credential for the rest of the API, and carries the
    // same project limits.
    assert.equal(
      (await call(base, session.accessToken, `/projects/${PROJECT_A}`)).status,
      200,
    );
    assert.equal(
      (await call(base, session.accessToken, `/projects/${PROJECT_B}`)).status,
      403,
    );

    const me = await call(base, session.accessToken, '/auth/me');
    assert.equal(me.status, 200);
    assert.equal((await me.json()).email, 'ahmed2@faultline.test');

    // Both outcomes are on the record.
    const failures = await audit.list({ action: 'auth.login.failed' });
    assert.equal(failures.length, 2);
    assert.equal(failures[0].outcome, 'denied');
    const successes = await audit.list({ action: 'auth.login.succeeded' });
    assert.equal(successes.length, 1);
    assert.equal(successes[0].actor, 'ahmed2@faultline.test');
  } finally {
    await app.close();
  }
});

test('an engineer is not told who else is assigned to their project', async () => {
  const { app, base, engineerToken, adminToken } = await boot();
  try {
    const mine = await call(base, engineerToken, "/projects");
    const [project] = await mine.json();
    assert.equal(project.id, PROJECT_A);
    assert.equal(
      project.assignedUserIds,
      undefined,
      "the assignment roster is an administrative fact, not a project detail",
    );
    const single = await call(base, engineerToken, `/projects/${PROJECT_A}`);
    assert.equal((await single.json()).assignedUserIds, undefined);

    // An Admin does see it: that is how the users screen shows assignment counts.
    const asAdmin = await call(base, adminToken, "/projects");
    const admins = await asAdmin.json();
    assert.ok(Array.isArray(admins.find((p) => p.id === PROJECT_A).assignedUserIds));
  } finally {
    await app.close();
  }
});

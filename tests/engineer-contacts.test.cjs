require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('@faultline/auth');
const { CLUSTER_DIRECTORY } = require('../apps/api/dist/clusters.controller');
const {
  AdminUsersController,
} = require('../apps/api/dist/auth/users.controller');
const {
  ContactsController,
} = require('../apps/api/dist/notification-management.controller');
const { bootWithRealGuards, tokenFor } = require('./auth-harness.cjs');

/*
 * Retell calls an onsite engineer through the notification contact linked to their
 * account. These tests hold the API to never leaving an engineer without one that can
 * take a voice call: not at creation, not by a later contact edit, not by a role change.
 */

const PROJECT = 'project-a';
const directory = {
  get: async (id) => (id === PROJECT ? { id, name: id } : undefined),
  list: async () => [],
};

async function boot() {
  const context = await bootWithRealGuards({
    controllers: [AdminUsersController, ContactsController],
    providers: [{ provide: CLUSTER_DIRECTORY, useValue: directory }],
  });
  const admin = await context.users.create({
    email: 'admin@faultline.test',
    name: 'Administrator',
    role: ROLES.ADMIN,
    password: 'correct-horse-battery',
  });
  await context.assignments.assign(admin.id, PROJECT, admin.id, []);
  return { ...context, token: tokenFor(admin) };
}

const call = (base, token, method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const engineer = (overrides = {}) => ({
  email: 'ahmed@faultline.test',
  name: 'Ahmed',
  role: ROLES.ONSITE_ENGINEER,
  password: 'correct-horse-battery',
  ...overrides,
});

test('an onsite engineer is not created without a valid E.164 phone number', async () => {
  const { app, base, token, users, contacts } = await boot();
  try {
    const missing = await call(base, token, 'POST', '/admin/users', engineer());
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).message, /phoneNumber is required/);

    const local = await call(base, token, 'POST', '/admin/users', engineer({ phoneNumber: '03001234567' }));
    assert.equal(local.status, 400);
    assert.match((await local.json()).message, /E\.164/);

    const silent = await call(
      base,
      token,
      'POST',
      '/admin/users',
      engineer({ phoneNumber: '+923001234567', voiceEnabled: false }),
    );
    assert.equal(silent.status, 400);
    assert.match((await silent.json()).message, /voice calls on/);

    // Refused before anything was written, not after the account already existed.
    assert.equal(await users.findByEmail('ahmed@faultline.test'), undefined);
    assert.deepEqual(await contacts.list(), []);
  } finally {
    await app.close();
  }
});

test('creating an onsite engineer links a callable contact in the same request', async () => {
  const { app, base, token, contacts } = await boot();
  try {
    const response = await call(
      base,
      token,
      'POST',
      '/admin/users',
      engineer({ phoneNumber: '+92 300 123-4567', smsEnabled: false, projectIds: [PROJECT] }),
    );
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.deepEqual(created.projectIds, [PROJECT]);
    assert.equal(created.contact.userId, created.id);
    assert.equal(created.contact.phoneNumber, '+923001234567', 'stored normalized');
    assert.equal(created.contact.role, 'ENGINEER');
    assert.equal(created.contact.voiceEnabled, true);
    assert.equal(created.contact.smsEnabled, false);
    assert.equal(created.contact.enabled, true);

    const linked = await contacts.findByUserIds([created.id], 'default');
    assert.deepEqual(linked.map((contact) => contact.id), [created.contact.id]);
  } finally {
    await app.close();
  }
});

test('an admin account needs no phone number', async () => {
  const { app, base, token, contacts } = await boot();
  try {
    const response = await call(base, token, 'POST', '/admin/users', {
      email: 'second-admin@faultline.test',
      name: 'Second Admin',
      role: ROLES.ADMIN,
      password: 'correct-horse-battery',
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).contact, undefined);
    assert.deepEqual(await contacts.list(), []);
  } finally {
    await app.close();
  }
});

test("an engineer's contact cannot have voice turned off or be disabled", async () => {
  const { app, base, token } = await boot();
  try {
    const created = await (
      await call(base, token, 'POST', '/admin/users', engineer({ phoneNumber: '+923001234567' }))
    ).json();
    const path = `/contacts/${created.contact.id}`;

    for (const change of [{ voiceEnabled: false }, { enabled: false }]) {
      const refused = await call(base, token, 'PATCH', path, change);
      assert.equal(refused.status, 400, `${JSON.stringify(change)} must be refused`);
    }
    // SMS stays optional, and the number itself can change to another valid one.
    assert.equal((await call(base, token, 'PATCH', path, { smsEnabled: false })).status, 200);
    const moved = await call(base, token, 'PATCH', path, { phoneNumber: '+15551234567' });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).voiceEnabled, true);

    const secondContact = await call(base, token, 'POST', '/contacts', {
      organizationId: 'default',
      userId: created.id,
      name: 'Ahmed',
      role: 'ENGINEER',
      phoneNumber: '+15551234567',
      voiceEnabled: false,
    });
    assert.equal(secondContact.status, 400);
  } finally {
    await app.close();
  }
});

test('an account becomes an onsite engineer only once it can be called', async () => {
  const { app, base, token, users } = await boot();
  try {
    const lead = await users.create({
      email: 'lead@faultline.test',
      name: 'Lead',
      role: ROLES.ADMIN,
      password: 'correct-horse-battery',
    });
    const demote = () =>
      call(base, token, 'PATCH', `/admin/users/${lead.id}`, { role: ROLES.ONSITE_ENGINEER });

    const refused = await demote();
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).message, /E\.164/);
    assert.equal((await users.findById(lead.id)).role, ROLES.ADMIN, 'nothing changed');

    const contact = await call(base, token, 'POST', '/contacts', {
      organizationId: 'default',
      userId: lead.id,
      name: 'Lead',
      role: 'ENGINEER',
      phoneNumber: '+15551234567',
    });
    assert.equal(contact.status, 201);
    assert.equal((await demote()).status, 200);
  } finally {
    await app.close();
  }
});

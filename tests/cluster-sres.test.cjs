require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('@faultline/auth');
const N = require('@faultline/notifications');
const {
  ClusterSresController,
} = require('../apps/api/dist/cluster-sres.controller');

async function harness() {
  const users = new A.InMemoryUserRepository();
  const assignments = new N.InMemoryClusterSreAssignmentRepository();
  const contacts = new N.InMemoryContactRepository();
  const admin = await users.create({
    organizationId: 'org', email: 'admin@example.com', name: 'Admin',
    role: A.ROLES.ADMIN, status: 'active',
  });
  const sre = await users.create({
    organizationId: 'org', email: 'sre@example.com', name: 'SRE One',
    role: A.ROLES.ONSITE_ENGINEER, status: 'active',
  });
  await contacts.create({
    id: 'contact-1', organizationId: 'org', userId: sre.id, name: sre.name,
    role: 'ENGINEER', phoneNumber: '+15550000001', smsEnabled: true,
    voiceEnabled: true, enabled: true, createdAt: '', updatedAt: '',
  });
  const audits = [];
  const controller = new ClusterSresController(
    {
      async get(id, organizationId) {
        return id === 'production' && organizationId === 'org'
          ? { id, name: 'Production' }
          : undefined;
      },
    },
    users,
    assignments,
    contacts,
    { async record(value) { audits.push(value); } },
  );
  return { controller, admin, sre, users, assignments, audits };
}

test('cluster SRE API lists, assigns, and unassigns organization SREs', async () => {
  const h = await harness();
  const actor = { ...h.admin, assignments: [] };
  const request = { headers: {} };
  const before = await h.controller.list('production', actor);
  assert.deepEqual(before.items.map((item) => ({
    id: item.id,
    assigned: item.assigned,
    phoneConfigured: item.phoneConfigured,
    voiceEnabled: item.voiceEnabled,
  })), [{
    id: h.sre.id,
    assigned: false,
    phoneConfigured: true,
    voiceEnabled: true,
  }]);

  await h.controller.assign(
    'production', { userId: h.sre.id }, actor, request,
  );
  assert.equal((await h.controller.list('production', actor)).items[0].assigned, true);
  assert.equal(h.audits[0].action, A.AUDIT_ACTIONS.CLUSTER_SRE_ASSIGNED);

  await h.controller.remove('production', h.sre.id, actor, request);
  assert.equal((await h.controller.list('production', actor)).items[0].assigned, false);
  assert.equal(h.audits[1].action, A.AUDIT_ACTIONS.CLUSTER_SRE_REMOVED);
});

test('cluster SRE API refuses admins and disabled engineers as call recipients', async () => {
  const h = await harness();
  const actor = { ...h.admin, assignments: [] };
  await assert.rejects(
    h.controller.assign('production', { userId: h.admin.id }, actor, { headers: {} }),
    /User must be an Onsite Engineer/,
  );
  const disabled = await h.users.create({
    organizationId: 'org', email: 'disabled@example.com', name: 'Disabled SRE',
    role: A.ROLES.ONSITE_ENGINEER, status: 'disabled',
  });
  await assert.rejects(
    h.controller.assign('production', { userId: disabled.id }, actor, { headers: {} }),
    /Disabled Onsite Engineers cannot be assigned/,
  );
});


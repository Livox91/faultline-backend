require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  CLUSTER_DIRECTORY,
  ClustersController,
} = require('../apps/api/dist/clusters.controller');
const { AuditTrail } = require('../apps/api/dist/auth/audit-trail');
const { PlanEntitlements } = require('../apps/api/dist/billing/entitlements');
const {
  AUDIT_LOG_REPOSITORY,
  PROJECT_ASSIGNMENT_REPOSITORY,
  InMemoryAuditLogRepository,
  InMemoryProjectAssignmentRepository,
} = require('@faultline/auth');
const { ApplicationLogger } = require('@faultline/platform');
const { actingAs, admin, silentLogger } = require('./auth-harness.cjs');

test('cluster API returns registration metadata without deriving namespaces from incidents', async () => {
  const registered = {
    id: 'faultline',
    name: 'faultline',
    kubernetesContext: 'kind-faultline',
    workloadNamespace: 'default',
    workloadSelector: 'app in (booknest-backend,booknest-frontend)',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    total: 0,
    open: 0,
    critical: 0,
  };
  class ClusterApiModule {}
  Module({
    controllers: [ClustersController],
    providers: [
      {
        provide: CLUSTER_DIRECTORY,
        useValue: {
          list: async () => [registered],
          get: async (id) => (id === registered.id ? registered : undefined),
          create: async () => registered,
          update: async () => registered,
          remove: async () => true,
        },
      },
      actingAs(admin({ assignments: [{ projectId: registered.id }] })),
      AuditTrail,
      // Reads never consult the plan; only registering a new cluster does.
      { provide: PlanEntitlements, useValue: { assertClusterCapacity: async () => {} } },
      { provide: AUDIT_LOG_REPOSITORY, useValue: new InMemoryAuditLogRepository() },
      {
        provide: PROJECT_ASSIGNMENT_REPOSITORY,
        useValue: new InMemoryProjectAssignmentRepository(),
      },
      { provide: ApplicationLogger, useValue: silentLogger },
    ],
  })(ClusterApiModule);
  const app = await NestFactory.create(ClusterApiModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/clusters`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [registered]);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await app.close();
  }
});

test('cluster registration accepts multiple clusters and idempotent retries per organization', async () => {
  const records = new Map();
  let creates = 0;
  const present = (value) => ({
    ...value,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    total: 0,
    open: 0,
    critical: 0,
  });
  const directory = {
    get: async (id, organizationId) => {
      const value = records.get(id);
      return value?.organizationId === organizationId ? present(value) : undefined;
    },
    create: async (value) => {
      creates += 1;
      records.set(value.id, value);
      return present(value);
    },
    update: async (id, changes) => {
      const current = records.get(id);
      if (!current) return undefined;
      const updated = { ...current, ...changes };
      records.set(id, updated);
      return present(updated);
    },
  };
  const assignments = [];
  const capacityChecks = [];
  const controller = new ClustersController(
    directory,
    { assign: async (...values) => assignments.push(values) },
    { record: async () => undefined },
    { assertClusterCapacity: async (user) => capacityChecks.push(user.id) },
  );
  const actor = { id: 'admin-1', organizationId: 'org-1' };

  await controller.create({ id: 'cluster-a', name: 'Cluster A' }, actor, {});
  await controller.create({ id: 'cluster-b', name: 'Cluster B' }, actor, {});
  const retried = await controller.create(
    { id: 'cluster-a', name: 'Cluster A renamed' },
    actor,
    {},
  );

  assert.equal(records.size, 2);
  assert.equal(creates, 2);
  assert.equal(retried.name, 'Cluster A renamed');
  assert.equal(assignments.length, 3);
  // Only the two new clusters counted against the plan; the idempotent retry did not.
  assert.deepEqual(capacityChecks, ['admin-1', 'admin-1']);
});

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
const { AUDIT_LOG_REPOSITORY, InMemoryAuditLogRepository } = require('@faultline/auth');
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
      // Reads are scoped by the caller; an Admin sees every project.
      actingAs(admin()),
      AuditTrail,
      { provide: AUDIT_LOG_REPOSITORY, useValue: new InMemoryAuditLogRepository() },
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

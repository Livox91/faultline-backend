require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  CLUSTER_DIRECTORY,
  ClustersController,
} = require('../apps/api/dist/clusters.controller');

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
        useValue: { list: async () => [registered] },
      },
    ],
  })(ClusterApiModule);
  const app = await NestFactory.create(ClusterApiModule, { logger: false });
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

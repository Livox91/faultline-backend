const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const {
  clusterName,
  controlPlaneIp,
  ClusterOnboardingController,
} = require('../apps/api/dist/cluster-onboarding.controller');

test('cluster onboarding validates names and control-plane IP addresses', () => {
  assert.equal(clusterName(' Production East '), 'Production East');
  assert.equal(controlPlaneIp(' 192.168.1.50 '), '192.168.1.50');
  assert.equal(controlPlaneIp('127.0.0.1:36443'), '127.0.0.1:36443');
  assert.equal(controlPlaneIp('2001:db8::1'), '2001:db8::1');
  assert.equal(controlPlaneIp('[2001:db8::1]:6443'), '[2001:db8::1]:6443');
  assert.throws(() => clusterName('../bad'));
  assert.throws(() => controlPlaneIp('localhost'));
  assert.throws(() => controlPlaneIp('127.0.0.1:70000'));
});

test('cluster onboarding starts a background job with normalized input', async () => {
  const calls = [];
  const capacityChecks = [];
  const clusters = { list: async () => [] };
  const controller = new ClusterOnboardingController(
    {
      start: (...args) => {
        calls.push(args);
        return { id: 'job-1', status: 'running' };
      },
      get: () => undefined,
    },
    // The plan's cluster allowance is checked before the job starts; tier rules
    // themselves are covered in entitlements.test.cjs.
    { assertClusterCapacity: async (...args) => capacityChecks.push(args) },
    clusters,
  );
  const actor = { id: 'user-1', organizationId: 'org-1' };
  assert.deepEqual(
    await controller.start({ clusterName: ' Demo ', controlPlaneIp: '10.0.0.8' }, actor),
    { id: 'job-1', status: 'running' },
  );
  assert.deepEqual(calls, [['Demo', '10.0.0.8', 'user-1']]);
  assert.deepEqual(capacityChecks, [[actor, clusters]]);
});

test('a refused cluster allowance never starts the onboarding job', async () => {
  const calls = [];
  const controller = new ClusterOnboardingController(
    { start: (...args) => calls.push(args) },
    {
      assertClusterCapacity: async () => {
        throw new Error('plan limit');
      },
    },
    { list: async () => [] },
  );
  await assert.rejects(
    controller.start(
      { clusterName: 'Demo', controlPlaneIp: '10.0.0.8' },
      { id: 'user-1', organizationId: 'org-1' },
    ),
    /plan limit/,
  );
  assert.equal(calls.length, 0);
});

test('the onboarding process receives the authenticated owner id', () => {
  const service = readFileSync(
    resolve(__dirname, '../apps/api/src/cluster-onboarding.service.ts'),
    'utf8',
  );
  assert.match(service, /'--owner-user-id',[\s\S]*ownerUserId/);
});

test('web onboarding supplies a generated identity instead of deriving one from context or port', () => {
  const service = readFileSync(
    resolve(__dirname, '../apps/api/src/cluster-onboarding.service.ts'),
    'utf8',
  );
  assert.match(service, /const clusterId = randomUUID\(\)/);
  assert.match(service, /'--id',[\s\S]*clusterId/);
});

test('cluster registration retries are tenant-safe and idempotent', () => {
  const script = readFileSync(
    resolve(__dirname, '../scripts/cluster.cjs'),
    'utf8',
  );
  assert.match(script, /ON CONFLICT \(id\) DO UPDATE SET/);
  assert.match(
    script,
    /WHERE clusters\.organization_id = EXCLUDED\.organization_id/,
  );
  assert.doesNotMatch(
    script,
    /organization_id=EXCLUDED\.organization_id/,
  );
  assert.match(
    script,
    /organization_id='default'[\s\S]*NOT EXISTS \([\s\S]*FROM project_users pu WHERE pu\.project_id=c\.id/,
  );
});

test('cluster uninstall is scoped to the authenticated owner and background job', () => {
  const calls = [];
  const controller = new ClusterOnboardingController({
    uninstall: (...args) => {
      calls.push(args);
      return { id: 'job-2', operation: 'uninstall', status: 'running' };
    },
  });
  const actor = {
    id: 'user-1',
    organizationId: 'org-1',
    status: 'active',
    assignments: [{ projectId: 'cluster-1' }],
  };

  assert.deepEqual(controller.uninstall('cluster-1', actor), {
    id: 'job-2',
    operation: 'uninstall',
    status: 'running',
  });
  assert.deepEqual(calls, [['cluster-1', 'user-1']]);
  assert.throws(() => controller.uninstall('cluster-2', actor));
});

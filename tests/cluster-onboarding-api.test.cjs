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

test('cluster onboarding starts a background job with normalized input', () => {
  const calls = [];
  const controller = new ClusterOnboardingController({
    start: (...args) => {
      calls.push(args);
      return { id: 'job-1', status: 'running' };
    },
    get: () => undefined,
  });
  assert.deepEqual(
    controller.start(
      { clusterName: ' Demo ', controlPlaneIp: '10.0.0.8' },
      { id: 'user-1' },
    ),
    { id: 'job-1', status: 'running' },
  );
  assert.deepEqual(calls, [['Demo', '10.0.0.8', 'user-1']]);
});

test('the onboarding process receives the authenticated owner id', () => {
  const service = readFileSync(
    resolve(__dirname, '../apps/api/src/cluster-onboarding.service.ts'),
    'utf8',
  );
  assert.match(service, /'--owner-user-id',[\s\S]*ownerUserId/);
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

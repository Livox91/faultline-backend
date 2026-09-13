const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'scripts/cluster.cjs'), 'utf8');
const {
  detectKubernetes,
  environmentFor,
  inferredEndpoint,
  validateEndpoint,
  registrationDefaults,
  podFailureReason,
} = require('../scripts/cluster.cjs');

function kubectlMock({ context = 'kind-demo', nodes = 1, ready = 1 } = {}) {
  return (_command, args) => {
    if (args[0] === 'version') return 'Client Version: v1.32.0';
    if (args[0] === 'config') return context;
    if (args.includes('nodes'))
      return JSON.stringify({
        items: Array.from({ length: nodes }, (_, index) => ({
          metadata: { name: `node-${index}` },
          status: {
            conditions: [
              { type: 'Ready', status: index < ready ? 'True' : 'False' },
            ],
          },
        })),
      });
    throw new Error(`Unexpected kubectl arguments: ${args.join(' ')}`);
  };
}

test('kubectl missing has a beginner-friendly failure', () => {
  assert.throws(
    () =>
      detectKubernetes(() => {
        throw new Error('ENOENT');
      }),
    /kubectl is not installed.*run this command again/i,
  );
});

test('cluster unavailable has a beginner-friendly failure', () => {
  const execute = kubectlMock();
  assert.throws(
    () =>
      detectKubernetes((command, args, options) => {
        if (args.includes('nodes')) throw new Error('connection refused');
        return execute(command, args, options);
      }),
    /cluster kind-demo cannot be reached.*cluster is running/i,
  );
});

test('kind cluster is detected with local Docker networking', () => {
  const detected = detectKubernetes(kubectlMock());
  assert.deepEqual(detected, {
    context: 'kind-demo',
    nodes: 1,
    ready: 1,
    environment: 'kind',
  });
  assert.equal(
    inferredEndpoint(detected.context),
    'http://host.docker.internal:3001',
  );
});

test('external cluster does not assume a Docker host address', () => {
  assert.equal(environmentFor('production-us-east'), 'external');
  assert.equal(inferredEndpoint('production-us-east'), undefined);
});

test('existing installation reuses identity only for the same context', () => {
  const prior = {
    context: 'kind-demo',
    clusterId: 'saved-id',
    clusterName: 'Saved name',
    ingestionEndpoint: 'http://host.docker.internal:3001',
  };
  assert.deepEqual(registrationDefaults('kind-demo', prior), {
    clusterId: 'saved-id',
    clusterName: 'Saved name',
    ingestionEndpoint: 'http://host.docker.internal:3001',
  });
  assert.equal(registrationDefaults('kind-other', prior).clusterId, 'other');
});

test('fresh installation derives a stable beginner-friendly identity', () => {
  assert.deepEqual(registrationDefaults('kind-faultline-demo'), {
    clusterId: 'faultline-demo',
    clusterName: 'faultline-demo',
    ingestionEndpoint: undefined,
  });
});

test('invalid and localhost Faultline endpoints are rejected', () => {
  assert.throws(() => validateEndpoint('not an address'), /valid URL/i);
  assert.throws(
    () => validateEndpoint('http://localhost:3001'),
    /cannot use localhost/i,
  );
});

test('collector startup failure surfaces the Kubernetes waiting reason', () => {
  assert.equal(
    podFailureReason([
      {
        status: {
          containerStatuses: [
            {
              restartCount: 0,
              state: { waiting: { reason: 'ImagePullBackOff' } },
            },
          ],
        },
      },
    ]),
    'ImagePullBackOff',
  );
});

test('successful onboarding checks the real path and removes its test namespace', () => {
  assert.match(source, /await chooseReachableEndpoint\(state, rl\)/);
  assert.match(source, /await install\(state,[\s\S]*guided: true/);
  assert.match(source, /await verify\(state, \{ guided: true/);
  assert.match(source, /cleanupTestWorkload\(state, \{ guided: true \}\)/);
  assert.match(source, /Faultline Kubernetes Setup Complete/);
});

test('rerunning onboarding repairs resources with apply and database upsert', () => {
  assert.match(source, /kubectl\(state, \['apply', '-f', '-'\]/);
  assert.match(source, /\['apply', '-k', 'deploy\/kubernetes'\]/);
  assert.match(source, /ON CONFLICT \(id\) DO UPDATE/);
  assert.doesNotMatch(source, /cluster-admin/);
});

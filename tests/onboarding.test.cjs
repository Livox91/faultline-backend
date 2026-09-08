const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('onboarding exposes one-command setup, startup, and cluster verification', () => {
  const scripts = require('../package.json').scripts;
  for (const name of [
    'setup',
    'preflight',
    'faultline:start',
    'cluster:onboard',
    'cluster:verify',
    'cluster:uninstall',
    'dev:reset',
  ])
    assert.equal(typeof scripts[name], 'string', name);
  assert.match(read('ONBOARDING.md'), /BookNest/i);
  assert.match(read('ONBOARDING.md'), /host\.docker\.internal/);
});

test('collector installation is outbound-only and cannot read Secrets', () => {
  const rbac = read('deploy/kubernetes/rbac.yaml');
  const logs = `${read('deploy/kubernetes/logs.yaml')}\n${read(
    'deploy/kubernetes/collector-logs.yaml',
  )}`;
  assert.doesNotMatch(rbac, /resources:\s*\[[^\]]*secrets/i);
  assert.match(logs, /readOnly:\s*true/);
  assert.match(logs, /\/var\/log\/pods/);
  assert.match(logs, /FAULTLINE_LOGS_ENDPOINT/);
  assert.match(logs, /FAULTLINE_METRICS_ENDPOINT/);
});

test('verification workload emits raw and classifiable evidence without credentials', () => {
  const manifest = read('deploy/kubernetes/onboarding-test.yaml');
  assert.match(manifest, /FAULTLINE_ONBOARDING_TEST/);
  assert.match(
    manifest,
    /database connection refused FAULTLINE_ONBOARDING_CLASSIFICATION_TEST/,
  );
  assert.doesNotMatch(manifest, /kind:\s*Secret/);
  assert.match(manifest, /runAsNonRoot:\s*true/);
});

test('destructive development reset requires explicit confirmation', () => {
  const reset = read('scripts/reset-development.cjs');
  assert.match(reset, /--confirm-destroy-data/);
  assert.match(reset, /down[\s\S]*--volumes/);
});

test('setup generates database credentials instead of hardcoding them', () => {
  const setup = read('scripts/setup.cjs');
  assert.match(setup, /POSTGRES_PASSWORD:\s*secret\(\)/);
  assert.doesNotMatch(setup, /admin123|password123/i);
  assert.match(
    read('scripts/bootstrap-infrastructure.cjs'),
    /No data was changed or deleted/,
  );
});

test('combined development pipeline loads every application environment', () => {
  const pipeline = read('scripts/dev-pipeline.cjs');
  assert.match(pipeline, /\['api', 'ingestion', 'processor', 'storage'\]/);
  assert.match(pipeline, /parseEnv/);
  assert.match(pipeline, /key !== 'PORT'/);
});

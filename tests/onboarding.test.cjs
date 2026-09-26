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

test('verification workload emits a finite non-operational probe without credentials', () => {
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
  assert.match(setup, /AUTH_JWT_SECRET=\$\{authJwtSecret\}/);
  assert.match(
    setup,
    /AUTH_BOOTSTRAP_ADMIN_PASSWORD=\$\{bootstrapAdminPassword\}/,
  );
  assert.match(setup, /value\.length >= 12/);
  assert.match(setup, /'apps\/storage\/\.env':[^\n]*DATABASE_URL=\$\{databaseUrl\}/);
  assert.match(setup, /requiredLocalFields/);
  assert.doesNotMatch(setup, /admin123|password123/i);
  assert.match(
    read('scripts/bootstrap-infrastructure.cjs'),
    /No data was changed or deleted/,
  );
});

test('setup repairs PostgreSQL ports reserved by Windows', () => {
  const {
    parseExcludedPortRanges,
    isPortExcluded,
    chooseUnexcludedPort,
  } = require('../scripts/onboarding/ports.cjs');
  const ranges = parseExcludedPortRanges(`
Start Port    End Port
----------    --------
     50000       50059     *
     55423       55522
`);
  assert.deepEqual(ranges, [
    { start: 50000, end: 50059 },
    { start: 55423, end: 55522 },
  ]);
  assert.equal(isPortExcluded(55432, ranges), true);
  assert.equal(chooseUnexcludedPort(55432, ranges), 5432);

  const setup = read('scripts/setup.cjs');
  assert.match(setup, /replacedPostgresPort/);
  assert.match(setup, /PostgreSQL port repaired/);
});

test('combined development pipeline loads every application environment', () => {
  const pipeline = read('scripts/dev-pipeline.cjs');
  assert.match(pipeline, /\['api', 'ingestion', 'processor', 'storage'\]/);
  assert.match(pipeline, /parseEnv/);
  assert.match(pipeline, /key !== 'PORT'/);
});

test('cluster registration is persisted before local onboarding state', () => {
  const cluster = read('scripts/cluster.cjs');
  assert.match(
    cluster,
    /INSERT INTO clusters[\s\S]*workload_namespace[\s\S]*ON CONFLICT \(id\) DO UPDATE/,
  );
  assert.match(cluster, /await persistCluster\(state\);\s*saveState\(state\);/);
  assert.match(
    cluster,
    /context\.startsWith\('kind-'\) \? context\.slice\(5\)/,
  );
  assert.match(cluster, /if \(command === 'add'\) await register\(\);/);
});

test('onboarding probes are finite and their persisted artifacts are cleaned', () => {
  const manifest = read('deploy/kubernetes/onboarding-test.yaml');
  const cluster = read('scripts/cluster.cjs');
  assert.doesNotMatch(manifest, /while true/);
  assert.match(manifest, /sleep 5[\s\S]*FAULTLINE_ONBOARDING_TEST/);
  assert.match(
    cluster,
    /DELETE FROM incidents WHERE cluster_id = \$1 AND namespace = \$2/,
  );
  assert.match(cluster, /ALTER TABLE[\s\S]*DELETE WHERE cluster_id/);
  assert.match(cluster, /faultline:rules:state:v1/);
  assert.match(cluster, /finally \{\s*await cleanup\(\);\s*\}/);
  assert.match(
    cluster,
    /rollout[\s\S]*restart[\s\S]*daemonset\/faultline-collector-logs/,
  );
});

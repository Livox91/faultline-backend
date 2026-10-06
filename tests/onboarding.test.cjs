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
    'cluster:import',
    'cluster:verify',
    'cluster:uninstall',
    'dev:reset',
  ])
    assert.equal(typeof scripts[name], 'string', name);
  assert.match(read('ONBOARDING.md'), /BookNest/i);
  assert.match(read('ONBOARDING.md'), /host\.docker\.internal/);
});

test('remote kubeconfig import verifies before replacing and is selected automatically', () => {
  const importer = read('scripts/import-kubeconfig.cjs');
  const library = read('scripts/onboarding/lib.cjs');
  assert.match(importer, /remote-kubeconfig\.pending/);
  assert.match(
    importer,
    /spawnSync[\s\S]*--kubeconfig[\s\S]*staged[\s\S]*copyFileSync\(staged, destination\)/,
  );
  assert.match(
    library,
    /if \(!environment\.KUBECONFIG && existsSync\(remoteKubeconfigPath\)\)/,
  );
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
  assert.match(setup, /isStrongPassword/);
  assert.match(
    setup,
    /configured !== slackTokenEncryptionKey[\s\S]*shared Slack key repaired/,
  );
  assert.match(
    setup,
    /'apps\/storage\/\.env':[^\n]*DATABASE_URL=\$\{databaseUrl\}/,
  );
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

test('direct notification migration compares retained text incident ids safely', () => {
  const migration = read(
    'packages/database/migrations/0014_direct_cluster_notifications.sql',
  );
  assert.match(migration, /JOIN incidents i ON i\.id::text = e\.incident_id/);
  assert.doesNotMatch(migration, /JOIN incidents i ON i\.id = e\.incident_id/);
});

test('project assignments enforce tenant ownership in PostgreSQL', () => {
  const migration = read(
    'packages/database/migrations/0025_project_assignment_organization_guard.sql',
  );
  assert.match(migration, /BEFORE INSERT OR UPDATE[\s\S]*ON project_users/);
  assert.match(
    migration,
    /user_organization IS DISTINCT FROM project_organization/,
  );
  assert.match(
    migration,
    /actor_organization IS DISTINCT FROM project_organization/,
  );
  assert.match(migration, /project_users_same_organization/);
});

test('combined development pipeline loads every application environment', () => {
  const pipeline = read('scripts/dev-pipeline.cjs');
  assert.match(
    pipeline,
    /\['api', 'ingestion', 'processor', 'storage', 'notification'\]/,
  );
  assert.match(pipeline, /notification: '3004'/);
  assert.match(pipeline, /parseEnv/);
  assert.match(pipeline, /key !== 'PORT'/);
});

test('notification participates in setup, readiness, and the shared lifecycle', () => {
  const setup = read('scripts/setup.cjs');
  const preflight = read('scripts/preflight.cjs');
  const start = read('scripts/faultline-start.cjs');
  const pipeline = read('scripts/dev-pipeline.cjs');

  assert.match(setup, /'apps\/notification\/\.env'/);
  assert.match(setup, /PORT=3004/);
  assert.match(setup, /SLACK_TOKEN_ENCRYPTION_KEY=\$\{slackTokenEncryptionKey\}/);
  assert.match(preflight, /'Faultline notification': 3004/);
  assert.match(start, /\[3000, 3001, 3002, 3003, 3004\]/);
  assert.match(
    pipeline,
    /\['processor', 'storage', 'notification', 'ingestion', 'api'\]/,
  );
});

test('setup provides a project-local Stripe CLI and clear next commands', () => {
  const packageJson = require('../package.json');
  assert.equal(typeof packageJson.devDependencies['@stripe/cli'], 'string');
  const setup = read('scripts/setup.cjs');
  assert.match(setup, /node_modules\/@stripe\/cli\/bin\/shim\.js/);
  assert.match(setup, /--include=optional/);
  assert.match(setup, /npm exec -- stripe login/);
  assert.match(setup, /npm run preflight/);
  assert.match(setup, /npm run faultline:start/);
  assert.match(setup, /npm run cluster:onboard/);

  const webhooks = read('scripts/stripe-webhooks.cjs');
  assert.match(webhooks, /LOCAL_STRIPE_BIN/);
  assert.match(webhooks, /cli-\$\{process\.platform\}-\$\{process\.arch\}/);
  for (const event of [
    'checkout.session.completed',
    'invoice.paid',
    'invoice.payment_failed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ])
    assert.match(webhooks, new RegExp(event.replaceAll('.', '\\.')));

  const preflight = read('scripts/preflight.cjs');
  assert.match(preflight, /Stripe CLI/);
  assert.match(preflight, /stripeAvailable/);
});

test('startup preserves an actionable Stripe forwarding failure', () => {
  const start = read('scripts/faultline-start.cjs');
  assert.match(
    start,
    /Applications are healthy, but Stripe webhook forwarding did not start/,
  );
  assert.match(start, /npm exec -- stripe login/);
  assert.match(start, /services\?\.every/);
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

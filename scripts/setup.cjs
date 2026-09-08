const { randomBytes } = require('node:crypto');
const {
  root,
  resolve,
  existsSync,
  parseEnv,
  writePrivate,
  saveState,
  statePath,
  readFileSync,
} = require('./onboarding/lib.cjs');

if (Number(process.versions.node.split('.')[0]) < 22)
  throw new Error(`Node.js 22+ is required; found ${process.version}`);

const secret = () => randomBytes(32).toString('base64url');
const force = process.argv.includes('--force');
const infrastructurePath = resolve(root, '.env.infrastructure');
let infrastructure = parseEnv(infrastructurePath);
const created = [];
if (!existsSync(infrastructurePath)) {
  infrastructure = {
    POSTGRES_USER: 'faultline',
    POSTGRES_PASSWORD: secret(),
    POSTGRES_DB: 'faultline',
    POSTGRES_PORT: '5432',
    REDIS_PORT: '6379',
    NATS_PORT: '4222',
    NATS_MONITOR_PORT: '8222',
    CLICKHOUSE_USER: 'faultline',
    CLICKHOUSE_PASSWORD: secret(),
    CLICKHOUSE_DB: 'faultline',
    CLICKHOUSE_HTTP_PORT: '8123',
  };
  writePrivate(
    infrastructurePath,
    Object.entries(infrastructure)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
  created.push('.env.infrastructure');
}

let infrastructureChanged = false;
for (const field of ['POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD']) {
  if (/replace-with|change-me|<generated/i.test(infrastructure[field] ?? '')) {
    infrastructure[field] = secret();
    infrastructureChanged = true;
  }
}
if (infrastructureChanged) {
  writePrivate(
    infrastructurePath,
    Object.entries(infrastructure)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    true,
  );
  created.push('.env.infrastructure (placeholder credentials replaced)');
}

for (const field of [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'CLICKHOUSE_USER',
  'CLICKHOUSE_PASSWORD',
])
  if (!infrastructure[field])
    throw new Error(
      `.env.infrastructure is missing ${field}. Compare it with .env.infrastructure.example.`,
    );

const encode = encodeURIComponent;
const postgresPort = infrastructure.POSTGRES_PORT || '5432';
const redisPort = infrastructure.REDIS_PORT || '6379';
const natsPort = infrastructure.NATS_PORT || '4222';
const clickhousePort = infrastructure.CLICKHOUSE_HTTP_PORT || '8123';
const databaseUrl = `postgresql://${encode(infrastructure.POSTGRES_USER)}:${encode(infrastructure.POSTGRES_PASSWORD)}@127.0.0.1:${postgresPort}/${encode(infrastructure.POSTGRES_DB)}`;
const clickhouseUrl = `http://127.0.0.1:${clickhousePort}`;
const token = secret();
const common =
  'NODE_ENV=development\nAPP_VERSION=0.1.0\nHOST=0.0.0.0\nLOG_LEVEL=log\n';
const files = {
  'apps/api/.env': `${common}PORT=3000\nDATABASE_URL=${databaseUrl}\nCLICKHOUSE_URL=${clickhouseUrl}\nCLICKHOUSE_DATABASE=${infrastructure.CLICKHOUSE_DB || 'faultline'}\nCLICKHOUSE_USERNAME=${infrastructure.CLICKHOUSE_USER}\nCLICKHOUSE_PASSWORD=${infrastructure.CLICKHOUSE_PASSWORD}\n`,
  'apps/ingestion/.env': `${common}PORT=3001\nFAULTLINE_DEV_AGENT_TOKEN=${token}\nBROKER_URL=nats://127.0.0.1:${natsPort}\nBROKER_CLIENT_ID=faultline\nBROKER_CONSUMER_GROUP=faultline-processors\n`,
  'apps/processor/.env': `${common}PORT=3002\nDATABASE_URL=${databaseUrl}\nREDIS_URL=redis://127.0.0.1:${redisPort}\nBROKER_URL=nats://127.0.0.1:${natsPort}\nBROKER_CLIENT_ID=faultline\nBROKER_CONSUMER_GROUP=faultline-processors\nLOG_CLASSIFIER_ENABLED=true\n`,
  'apps/storage/.env': `${common}PORT=3003\nBROKER_URL=nats://127.0.0.1:${natsPort}\nBROKER_CLIENT_ID=faultline\nBROKER_CONSUMER_GROUP=faultline-processors\nTELEMETRY_STORAGE_CONSUMER_GROUP=faultline-telemetry-storage\nCLICKHOUSE_URL=${clickhouseUrl}\nCLICKHOUSE_DATABASE=${infrastructure.CLICKHOUSE_DB || 'faultline'}\nCLICKHOUSE_USERNAME=${infrastructure.CLICKHOUSE_USER}\nCLICKHOUSE_PASSWORD=${infrastructure.CLICKHOUSE_PASSWORD}\n`,
};
for (const [relative, content] of Object.entries(files)) {
  const path = resolve(root, relative);
  const replacePlaceholder =
    existsSync(path) &&
    /replace-with|change-me|<generated/i.test(readFileSync(path, 'utf8'));
  if (writePrivate(path, content, force || replacePlaceholder))
    created.push(relative);
}

const ingestion = parseEnv(resolve(root, 'apps/ingestion/.env'));
const effectiveToken = ingestion.FAULTLINE_DEV_AGENT_TOKEN;
if (!effectiveToken || effectiveToken === 'change-me-local-only')
  throw new Error(
    'apps/ingestion/.env needs a non-placeholder FAULTLINE_DEV_AGENT_TOKEN.',
  );
let prior = {};
if (existsSync(statePath)) {
  try {
    prior = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {}
}
saveState({
  version: 1,
  clusterId: prior.clusterId || 'booknest-development',
  clusterName: prior.clusterName || 'BookNest local cluster',
  ...(prior.context ? { context: prior.context } : {}),
  ingestionEndpoint:
    prior.ingestionEndpoint || 'http://host.docker.internal:3001',
  token: effectiveToken,
  workloadNamespace: prior.workloadNamespace || 'default',
  workloadLabel: prior.workloadLabel || 'app=booknest-backend',
  ...(prior.insecureKubelet ? { insecureKubelet: prior.insecureKubelet } : {}),
});

console.log('Faultline local configuration is ready.');
console.log(
  created.length
    ? `Created: ${created.join(', ')}`
    : 'Existing configuration was preserved.',
);
console.log(
  'Development credentials were stored locally and were not printed.',
);

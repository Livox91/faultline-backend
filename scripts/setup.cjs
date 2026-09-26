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
  run,
} = require('./onboarding/lib.cjs');
const {
  windowsExcludedTcpRanges,
  isPortExcluded,
  chooseUnexcludedPort,
} = require('./onboarding/ports.cjs');

if (Number(process.versions.node.split('.')[0]) < 22)
  throw new Error(`Node.js 22+ is required; found ${process.version}`);

const stripeShim = resolve(root, 'node_modules/@stripe/cli/bin/shim.js');
const stripeReady = () => {
  if (!existsSync(stripeShim)) return false;
  try {
    run(process.execPath, [stripeShim, '--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};
if (!stripeReady()) {
  console.log('Installing the project-local Stripe CLI...');
  try {
    // @stripe/cli is a devDependency. This also repairs a checkout installed with
    // `npm install --omit=dev`, without modifying global tools or requiring admin rights.
    run(
      'npm',
      [
        'install',
        '--include=dev',
        '--include=optional',
        '--no-audit',
        '--no-fund',
      ],
      {
        inherit: true,
        timeout: 180_000,
      },
    );
  } catch (error) {
    throw new Error(
      `Stripe CLI installation failed. Run "npm install", then rerun "npm run setup".\n${error.message}`,
    );
  }
}
if (!stripeReady())
  throw new Error(
    'Stripe CLI installation is incomplete. Run "npm install --include=dev --include=optional" and retry.',
  );

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

const configuredPostgresPort = Number(infrastructure.POSTGRES_PORT || 5432);
if (
  !Number.isInteger(configuredPostgresPort) ||
  configuredPostgresPort < 1 ||
  configuredPostgresPort > 65535
)
  throw new Error(
    `.env.infrastructure contains an invalid POSTGRES_PORT: ${infrastructure.POSTGRES_PORT}`,
  );

const excludedTcpRanges = windowsExcludedTcpRanges();
let replacedPostgresPort;
if (isPortExcluded(configuredPostgresPort, excludedTcpRanges)) {
  const replacement = chooseUnexcludedPort(5432, excludedTcpRanges);
  if (!replacement)
    throw new Error(
      'Windows has reserved the configured PostgreSQL port and no safe fallback port was found.',
    );
  replacedPostgresPort = configuredPostgresPort;
  infrastructure.POSTGRES_PORT = String(replacement);
  infrastructureChanged = true;
}
if (infrastructureChanged) {
  writePrivate(
    infrastructurePath,
    Object.entries(infrastructure)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    true,
  );
  created.push('.env.infrastructure (configuration repaired)');
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
const authJwtSecret = secret();
const bootstrapAdminEmail = 'admin@faultline.local';
const bootstrapAdminPassword = secret();
const common =
  'NODE_ENV=development\nAPP_VERSION=0.1.0\nHOST=0.0.0.0\nLOG_LEVEL=log\n';
const files = {
  'apps/api/.env': `${common}PORT=3000\nDATABASE_URL=${databaseUrl}\nCLICKHOUSE_URL=${clickhouseUrl}\nCLICKHOUSE_DATABASE=${infrastructure.CLICKHOUSE_DB || 'faultline'}\nCLICKHOUSE_USERNAME=${infrastructure.CLICKHOUSE_USER}\nCLICKHOUSE_PASSWORD=${infrastructure.CLICKHOUSE_PASSWORD}\nAUTH_JWT_SECRET=${authJwtSecret}\nAUTH_BOOTSTRAP_ADMIN_EMAIL=${bootstrapAdminEmail}\nAUTH_BOOTSTRAP_ADMIN_PASSWORD=${bootstrapAdminPassword}\n`,
  'apps/ingestion/.env': `${common}PORT=3001\nFAULTLINE_DEV_AGENT_TOKEN=${token}\nBROKER_URL=nats://127.0.0.1:${natsPort}\nBROKER_CLIENT_ID=faultline\nBROKER_CONSUMER_GROUP=faultline-processors\n`,
  'apps/processor/.env': `${common}PORT=3002\nDATABASE_URL=${databaseUrl}\nREDIS_URL=redis://127.0.0.1:${redisPort}\nBROKER_URL=nats://127.0.0.1:${natsPort}\nBROKER_CLIENT_ID=faultline\nBROKER_CONSUMER_GROUP=faultline-processors\nLOG_CLASSIFIER_ENABLED=true\n`,
  'apps/storage/.env': `${common}PORT=3003\nDATABASE_URL=${databaseUrl}\nBROKER_URL=nats://127.0.0.1:${natsPort}\nBROKER_CLIENT_ID=faultline\nBROKER_CONSUMER_GROUP=faultline-processors\nTELEMETRY_STORAGE_CONSUMER_GROUP=faultline-telemetry-storage\nCLICKHOUSE_URL=${clickhouseUrl}\nCLICKHOUSE_DATABASE=${infrastructure.CLICKHOUSE_DB || 'faultline'}\nCLICKHOUSE_USERNAME=${infrastructure.CLICKHOUSE_USER}\nCLICKHOUSE_PASSWORD=${infrastructure.CLICKHOUSE_PASSWORD}\n`,
};
for (const [relative, content] of Object.entries(files)) {
  const path = resolve(root, relative);
  const replacePlaceholder =
    existsSync(path) &&
    /replace-with|change-me|<generated/i.test(readFileSync(path, 'utf8'));
  if (writePrivate(path, content, force || replacePlaceholder))
    created.push(relative);
}

// If setup repaired a Windows-reserved infrastructure port, update only local
// loopback PostgreSQL URLs. Other application settings and secrets stay intact.
if (replacedPostgresPort !== undefined) {
  for (const relative of [
    'apps/api/.env',
    'apps/processor/.env',
    'apps/storage/.env',
  ]) {
    const path = resolve(root, relative);
    if (!existsSync(path)) continue;
    const current = readFileSync(path, 'utf8').replace(/\r+\n/g, '\n');
    const updated = current.replaceAll(
      `127.0.0.1:${replacedPostgresPort}/`,
      `127.0.0.1:${infrastructure.POSTGRES_PORT}/`,
    );
    if (updated === current) continue;
    writePrivate(path, updated, true);
    created.push(`${relative} (PostgreSQL port repaired)`);
  }
  console.log(
    `POSTGRES_PORT ${replacedPostgresPort} is reserved by Windows; using ${infrastructure.POSTGRES_PORT} instead.`,
  );
}

// Keep older local configurations working as new required settings are added.
// Re-running setup must not rotate existing credentials or overwrite custom values.
// Bootstrap credentials are special: after first sign-in operators are told to remove
// both fields, so an intentional removal must stay removed. Repair them only when one
// half is present (as in an older or partially edited local configuration).
const existingApi = parseEnv(resolve(root, 'apps/api/.env'));
const bootstrapConfigured =
  !!existingApi.AUTH_BOOTSTRAP_ADMIN_EMAIL ||
  !!existingApi.AUTH_BOOTSTRAP_ADMIN_PASSWORD;
const requiredLocalFields = {
  'apps/api/.env': {
    AUTH_JWT_SECRET: {
      value: authJwtSecret,
      valid: (value) => typeof value === 'string' && value.length >= 32,
    },
    ...(bootstrapConfigured
      ? {
          AUTH_BOOTSTRAP_ADMIN_EMAIL: {
            value: bootstrapAdminEmail,
            valid: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value ?? ''),
          },
          AUTH_BOOTSTRAP_ADMIN_PASSWORD: {
            value: bootstrapAdminPassword,
            valid: (value) => typeof value === 'string' && value.length >= 12,
          },
        }
      : {}),
  },
  'apps/storage/.env': {
    DATABASE_URL: { value: databaseUrl, valid: (value) => !!value },
  },
};
for (const [relative, required] of Object.entries(requiredLocalFields)) {
  const path = resolve(root, relative);
  if (!existsSync(path)) continue;
  // Normalize before writePrivate converts LF to the platform newline. Passing an
  // existing CRLF file through unchanged would otherwise accumulate stray CR bytes.
  const current = readFileSync(path, 'utf8').replace(/\r+\n/g, '\n');
  const values = parseEnv(path);
  const repairs = Object.entries(required).filter(
    ([key, requirement]) => !requirement.valid(values[key]),
  );
  if (!repairs.length) continue;
  let updated = current;
  for (const [key, requirement] of repairs) {
    const line = `${key}=${requirement.value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(updated)) updated = updated.replace(pattern, line);
    else {
      const separator =
        updated.endsWith('\n') || updated.length === 0 ? '' : '\n';
      updated = `${updated}${separator}${line}\n`;
    }
  }
  writePrivate(path, updated, true);
  created.push(`${relative} (invalid or missing required fields repaired)`);
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
console.log(
  'Stripe CLI is installed locally; use it through npm exec -- stripe.',
);
const api = parseEnv(resolve(root, 'apps/api/.env'));
console.log('\nNext commands:');
if (
  api.BILLING_ENABLED === 'true' &&
  !api.STRIPE_SECRET_KEY &&
  !process.env.STRIPE_API_KEY
)
  console.log(
    '  npm exec -- stripe login   # required for local billing webhooks',
  );
console.log('  npm run preflight');
console.log('  npm run faultline:start');
console.log('  npm run cluster:onboard');

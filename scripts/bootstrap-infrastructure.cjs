const { root, resolve, parseEnv, run } = require('./onboarding/lib.cjs');

const values = parseEnv(resolve(root, '.env.infrastructure'));
if (!Object.keys(values).length)
  throw new Error('Missing .env.infrastructure. Run: npm run setup');
const databaseUrl = `postgresql://${encodeURIComponent(values.POSTGRES_USER)}:${encodeURIComponent(values.POSTGRES_PASSWORD)}@127.0.0.1:${values.POSTGRES_PORT || 5432}/${encodeURIComponent(values.POSTGRES_DB)}`;
const environment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  CLICKHOUSE_URL: `http://127.0.0.1:${values.CLICKHOUSE_HTTP_PORT || 8123}`,
  CLICKHOUSE_DATABASE: values.CLICKHOUSE_DB || 'faultline',
  CLICKHOUSE_USERNAME: values.CLICKHOUSE_USER,
  CLICKHOUSE_PASSWORD: values.CLICKHOUSE_PASSWORD,
};

run(
  'docker',
  [
    'compose',
    '--env-file',
    '.env.infrastructure',
    '-f',
    'compose.infrastructure.yml',
    'up',
    '-d',
    '--wait',
  ],
  { inherit: true, timeout: 180_000 },
);
run('npm', ['run', 'build'], { inherit: true, timeout: 180_000 });
run('npm', ['run', 'db:migrate'], {
  inherit: true,
  env: environment,
  timeout: 120_000,
});
run('npm', ['run', 'telemetry:schema'], {
  inherit: true,
  env: environment,
  timeout: 120_000,
});
console.log('PostgreSQL migrations and ClickHouse telemetry schema are ready.');

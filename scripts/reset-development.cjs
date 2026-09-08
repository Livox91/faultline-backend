const { run } = require('./onboarding/lib.cjs');
if (!process.argv.includes('--confirm-destroy-data')) {
  console.error(
    'Reset deletes Faultline PostgreSQL, Redis, NATS, and ClickHouse development volumes.\nRerun explicitly: npm run dev:reset -- --confirm-destroy-data',
  );
  process.exit(2);
}
run(
  'docker',
  [
    'compose',
    '--env-file',
    '.env.infrastructure',
    '-f',
    'compose.infrastructure.yml',
    'down',
    '--volumes',
  ],
  { inherit: true, timeout: 120_000 },
);
console.log(
  'Faultline development infrastructure and data volumes were removed.',
);

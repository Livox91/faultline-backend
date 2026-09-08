const net = require('node:net');
const {
  root,
  resolve,
  existsSync,
  parseEnv,
  run,
  requestJson,
} = require('./onboarding/lib.cjs');

const passed = [];
const warnings = [];
const failures = [];
function check(label, work, help) {
  try {
    work();
    passed.push(label);
  } catch (error) {
    failures.push(`${label}: ${error.message}\n  ${help}`);
  }
}
function tcp(port) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

(async () => {
  check(
    'Node.js 22+',
    () => {
      if (Number(process.versions.node.split('.')[0]) < 22)
        throw new Error(`found ${process.version}`);
    },
    'Install Node.js 22 or newer.',
  );
  check(
    'Docker engine',
    () => run('docker', ['info'], { timeout: 10_000 }),
    'Start Docker Desktop/the Docker daemon, then rerun npm run preflight.',
  );
  check(
    'kubectl client',
    () => run('kubectl', ['version', '--client'], { timeout: 10_000 }),
    'Install kubectl and ensure it is on PATH.',
  );
  check(
    'Kubernetes cluster',
    () =>
      run('kubectl', ['cluster-info', '--request-timeout=5s'], {
        timeout: 10_000,
      }),
    'Start the cluster or select a reachable context with kubectl config use-context <name>.',
  );

  const paths = [
    '.env.infrastructure',
    'apps/api/.env',
    'apps/ingestion/.env',
    'apps/processor/.env',
    'apps/storage/.env',
  ];
  check(
    'Faultline configuration',
    () => {
      const missing = paths.filter((path) => !existsSync(resolve(root, path)));
      if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
      for (const path of paths) {
        const values = parseEnv(resolve(root, path));
        if (
          Object.values(values).some((value) =>
            /replace-with|change-me|<generated/i.test(value),
          )
        )
          throw new Error(`${path} still contains a placeholder value`);
      }
    },
    'Run npm run setup to generate safe local configuration.',
  );

  const infrastructure = parseEnv(resolve(root, '.env.infrastructure'));
  let composeServices = new Set();
  try {
    composeServices = new Set(
      run(
        'docker',
        [
          'compose',
          '--env-file',
          '.env.infrastructure',
          '-f',
          'compose.infrastructure.yml',
          'ps',
          '--services',
          '--status',
          'running',
        ],
        { cwd: root, timeout: 10_000 },
      )
        .split(/\r?\n/)
        .filter(Boolean),
    );
  } catch {}
  const ports = {
    PostgreSQL: Number(infrastructure.POSTGRES_PORT || 5432),
    Redis: Number(infrastructure.REDIS_PORT || 6379),
    NATS: Number(infrastructure.NATS_PORT || 4222),
    'NATS monitor': Number(infrastructure.NATS_MONITOR_PORT || 8222),
    ClickHouse: Number(infrastructure.CLICKHOUSE_HTTP_PORT || 8123),
    'Faultline API': 3000,
    'Faultline ingestion': 3001,
    'Faultline processor': 3002,
    'Faultline storage': 3003,
  };
  const infrastructureServices = {
    PostgreSQL: 'postgres',
    Redis: 'redis',
    NATS: 'nats',
    'NATS monitor': 'nats',
    ClickHouse: 'clickhouse',
  };
  for (const [name, port] of Object.entries(ports)) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      failures.push(`${name} port: invalid port ${port}`);
      continue;
    }
    if (!(await tcp(port))) {
      passed.push(`${name} port ${port} is available`);
      continue;
    }
    const service = infrastructureServices[name];
    if (service && composeServices.has(service)) {
      passed.push(`${name} is running on port ${port}`);
    } else if (!service) {
      try {
        await requestJson(`http://127.0.0.1:${port}/health`, {
          timeout: 1_000,
        });
        passed.push(`${name} is running on port ${port}`);
      } catch {
        failures.push(
          `${name} port: ${port} is occupied by another process\n  Stop that process before starting Faultline.`,
        );
      }
    } else {
      failures.push(
        `${name} port: ${port} is occupied outside this Faultline Compose project\n  Stop that process or change the matching port in .env.infrastructure, then run npm run setup -- --force.`,
      );
    }
  }

  for (const [name, url] of [
    ['NATS', `http://127.0.0.1:${ports['NATS monitor']}/healthz`],
    ['ClickHouse', `http://127.0.0.1:${ports.ClickHouse}/ping`],
  ]) {
    try {
      await requestJson(url, { timeout: 1_000 });
      passed.push(`${name} reachable`);
    } catch {
      warnings.push(
        `${name} is not running yet; npm run faultline:start will start it`,
      );
    }
  }
  for (const [name, port] of [
    ['API', 3000],
    ['ingestion', 3001],
    ['processor', 3002],
    ['storage', 3003],
  ]) {
    try {
      await requestJson(`http://127.0.0.1:${port}/health/ready`, {
        timeout: 1_000,
      });
      passed.push(`Faultline ${name} reachable`);
    } catch {
      warnings.push(`Faultline ${name} is not running yet`);
    }
  }

  for (const item of passed) console.log(`✓ ${item}`);
  for (const item of warnings) console.log(`! ${item}`);
  for (const item of failures) console.error(`✗ ${item}`);
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(`Preflight failed: ${error.message}`);
  process.exitCode = 1;
});

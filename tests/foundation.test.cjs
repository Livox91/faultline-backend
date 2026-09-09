const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const { validateEnvironment, HealthService } = require('@faultline/platform');
const { telemetryEventSchema } = require('@faultline/telemetry');
const validEnvironment = { NODE_ENV: 'test', APP_VERSION: '0.1.0-test' };

const root = resolve(__dirname, '..');

test('shared packages resolve at runtime and telemetry validates envelopes', () => {
  const { telemetryEnvelopeSchema } = require('@faultline/telemetry');
  const envelope = {
    id: 'event-1',
    clusterId: 'cluster-1',
    kind: 'example',
    observedAt: '2026-09-08T00:00:00Z',
    payload: {},
  };
  assert.equal(telemetryEnvelopeSchema.safeParse(envelope).success, true);
  assert.equal(
    telemetryEnvelopeSchema.safeParse({ ...envelope, observedAt: 'bad' })
      .success,
    false,
  );
  const { payload, ...missingPayload } = envelope;
  assert.equal(
    telemetryEnvelopeSchema.safeParse(missingPayload).success,
    false,
  );
  assert.equal(typeof require('@faultline/database').DATABASE, 'symbol');
  assert.equal(typeof require('@faultline/queue').QUEUE, 'symbol');
  require('@faultline/kubernetes');
  require('@faultline/incidents');
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

for (const [index, app] of [
  'api',
  'ingestion',
  'processor',
  'storage',
].entries()) {
  test(`${app}: validates required settings and app-specific defaults`, () => {
    const validate = (values) => validateEnvironment(app, values);
    assert.equal(validate(validEnvironment).PORT, 3000 + index);
    assert.equal(validate({ ...validEnvironment, PORT: '4500' }).PORT, 4500);
    assert.throws(() => validate({}), /NODE_ENV.*APP_VERSION/);
    for (const key of ['NODE_ENV', 'APP_VERSION']) {
      const values = { ...validEnvironment };
      delete values[key];
      assert.throws(() => validate(values), new RegExp(key));
    }
    for (const PORT of ['', 'invalid', '0', '65536', '1.5']) {
      assert.throws(() => validate({ ...validEnvironment, PORT }), /PORT/);
    }
    assert.throws(
      () => validate({ ...validEnvironment, APP_VERSION: '  ' }),
      /APP_VERSION/,
    );
    assert.throws(() => validate({ ...validEnvironment, HOST: '' }), /HOST/);
    assert.throws(
      () => validate({ ...validEnvironment, LOG_LEVEL: 'secret-value' }),
      (error) =>
        error.message.includes('LOG_LEVEL') &&
        !error.message.includes('secret-value'),
    );
    assert.throws(
      () => validate({ ...validEnvironment, NODE_ENV: 'invalid' }),
      /NODE_ENV/,
    );
    assert.equal(validate(validEnvironment).ANOMALY_MEMORY_WARNING_PERCENT, 85);
    assert.equal(validate(validEnvironment).ANOMALY_RESTART_THRESHOLD, 3);
    assert.equal(
      validate(validEnvironment).INCIDENT_CORRELATION_WINDOW_MS,
      600000,
    );
    assert.equal(
      validate(validEnvironment).INCIDENT_STABILIZATION_PERIOD_MS,
      120000,
    );
    assert.throws(
      () =>
        validate({
          ...validEnvironment,
          ANOMALY_MEMORY_WARNING_PERCENT: '95',
          ANOMALY_MEMORY_CRITICAL_PERCENT: '95',
        }),
      /ANOMALY_MEMORY_CRITICAL_PERCENT/,
    );
    assert.throws(
      () =>
        validate({
          ...validEnvironment,
          ANOMALY_CPU_WARNING_PERCENT: '90',
          ANOMALY_CPU_CRITICAL_PERCENT: '80',
        }),
      /ANOMALY_CPU_CRITICAL_PERCENT/,
    );
    assert.throws(
      () =>
        validate({
          ...validEnvironment,
          ANOMALY_RESTART_THRESHOLD: '1',
        }),
      /ANOMALY_RESTART_THRESHOLD/,
    );
    assert.throws(
      () =>
        validate({
          ...validEnvironment,
          INCIDENT_CORRELATION_WINDOW_MS: '999',
        }),
      /INCIDENT_CORRELATION_WINDOW_MS/,
    );
    assert.throws(
      () =>
        validate({
          ...validEnvironment,
          INCIDENT_STABILIZATION_PERIOD_MS: '-1',
        }),
      /INCIDENT_STABILIZATION_PERIOD_MS/,
    );
    // Telemetry storage must never share the processor's durable broker consumer:
    // one group would split telemetry between them instead of fanning out.
    assert.notEqual(
      validate(validEnvironment).TELEMETRY_STORAGE_CONSUMER_GROUP,
      validate(validEnvironment).BROKER_CONSUMER_GROUP,
    );
    assert.throws(
      () =>
        validate({
          ...validEnvironment,
          TELEMETRY_STORAGE_CONSUMER_GROUP: 'faultline-processors',
        }),
      /TELEMETRY_STORAGE_CONSUMER_GROUP/,
    );
    assert.equal(validate(validEnvironment).TELEMETRY_RETENTION_LOGS_DAYS, 7);
    for (const days of ['0', '-1', '1.5'])
      assert.throws(
        () =>
          validate({
            ...validEnvironment,
            TELEMETRY_RETENTION_LOGS_DAYS: days,
          }),
        /TELEMETRY_RETENTION_LOGS_DAYS/,
      );
  });

  test(`${app}: resolves all shared packages from its workspace`, () => {
    const manifest = require(resolve(root, `apps/${app}/package.json`));
    const requireFromApp = createRequire(
      resolve(root, `apps/${app}/package.json`),
    );
    // Each app declares only the packages it uses; every declared one must resolve.
    const declared = Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith('@faultline/'),
    );
    assert.ok(declared.includes('@faultline/platform'));
    assert.ok(declared.includes('@faultline/telemetry'));
    for (const name of declared) {
      assert.doesNotThrow(() => requireFromApp(name));
    }
  });

  test(
    `${app}: invalid configuration exits with a structured error`,
    { timeout: 35000 },
    () => {
      const result = spawnSync(
        process.execPath,
        [resolve(root, `apps/${app}/dist/main.js`)],
        {
          cwd: root,
          env: { ...process.env, NODE_ENV: 'test', APP_VERSION: '' },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      const logs = (result.stdout + result.stderr)
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);
      assert.ok(
        logs.some(
          (entry) =>
            entry.application === app &&
            entry.level === 'error' &&
            entry.message.includes('APP_VERSION'),
        ),
      );
    },
  );

  test(
    `${app}: independently boots and serves health with JSON logs`,
    { timeout: 45000 },
    async () => {
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [resolve(root, `apps/${app}/dist/main.js`)],
        {
          cwd: root,
          env: {
            ...process.env,
            ...validEnvironment,
            HOST: '127.0.0.1',
            PORT: String(port),
            LOG_LEVEL: 'log',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const exited = once(child, 'exit');
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      try {
        let response;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          assert.equal(child.exitCode, null, output);
          try {
            response = await fetch(`http://127.0.0.1:${port}/health`, {
              signal: AbortSignal.timeout(500),
            });
            break;
          } catch {
            await new Promise((done) => setTimeout(done, 100));
          }
        }
        assert.ok(response, output || 'Application did not start');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const health = await response.json();
        assert.equal(health.application, app);
        assert.equal(health.status, 'ok');
        assert.ok(Number.isFinite(health.uptime) && health.uptime >= 0);
        const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
        assert.equal(ready.status, 200);
        const readiness = await ready.json();
        assert.equal(readiness.application, app);
        assert.equal(readiness.status, 'ok');
        assert.ok(readiness.uptime >= health.uptime);
        const info = await fetch(`http://127.0.0.1:${port}/system/info`);
        if (app === 'api') {
          assert.equal(info.status, 200);
          assert.deepEqual(await info.json(), {
            application: 'api',
            environment: 'test',
            version: validEnvironment.APP_VERSION,
            enabledComponents: [
              'configuration',
              'logging',
              'health',
              'system-info',
              'incidents',
              'telemetry-search',
              'baselines',
            ],
          });
        } else {
          assert.equal(info.status, 404);
        }
        const missing = await fetch(`http://127.0.0.1:${port}/not-a-route`);
        assert.equal(missing.status, 404);
        const logs = output
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        assert.ok(
          logs.some((entry) => entry.message?.event === 'application_started'),
        );
        assert.ok(
          logs.every(
            (entry) =>
              entry.application === app &&
              Number.isFinite(entry.timestamp) &&
              typeof entry.level === 'string' &&
              Object.hasOwn(entry, 'message'),
          ),
        );
      } finally {
        child.kill('SIGTERM');
        await exited;
      }
    },
  );
}

test('health service reports application and process uptime', (context) => {
  context.mock.method(process, 'uptime', () => 42.5);
  const health = new HealthService({ application: 'processor' });
  assert.deepEqual(health.getStatus(), {
    application: 'processor',
    status: 'ok',
    uptime: 42.5,
  });
});

test('logger retains application across contexts and filters levels', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { ApplicationLogger } = require('@faultline/platform');
    const logger = new ApplicationLogger('ingestion', 'warn');
    logger.log('filtered');
    logger.warn('visible', 'SharedLibrary');
    logger.error(new Error('failure'), 'SharedLibrary');
  `,
    ],
    { cwd: root, encoding: 'utf8', timeout: 30000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const logs = (result.stdout + result.stderr)
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  assert.equal(logs.length, 2);
  assert.ok(
    logs.every(
      (entry) =>
        entry.application === 'ingestion' &&
        entry.context === 'SharedLibrary' &&
        Number.isFinite(entry.timestamp),
    ),
  );
  assert.equal(logs[0].message, 'visible');
  assert.equal(logs[1].level, 'error');
});

const metadata = {
  id: 'event-1',
  timestamp: '2026-09-08T10:00:00Z',
  clusterId: 'cluster-1',
  namespace: 'default',
  pod: 'api-1',
  container: 'api',
  node: 'worker-1',
  service: 'api',
  workload: 'api',
  attributes: { source: 'test', nested: { count: 2 }, tags: ['a'] },
  raw: { original: true },
};
const events = [
  { ...metadata, kind: 'log', level: 'info', message: 'Started' },
  {
    ...metadata,
    kind: 'metric',
    name: 'cpu_usage',
    value: 0.2,
    unit: 'cores',
    metricType: 'gauge',
  },
  {
    ...metadata,
    kind: 'kubernetes',
    type: 'Warning',
    reason: 'BackOff',
    message: 'Restarting',
    involvedObject: {
      clusterId: 'cluster-1',
      apiVersion: 'v1',
      kind: 'Pod',
      name: 'api-1',
      namespace: 'default',
    },
    count: 1,
  },
];

test('telemetry validates all event variants and preserves common metadata', () => {
  for (const event of events) {
    assert.deepEqual(telemetryEventSchema.parse(event), event);
  }
  const {
    namespace,
    pod,
    container,
    node,
    service,
    workload,
    attributes,
    ...clusterEvent
  } = events[0];
  assert.deepEqual(
    telemetryEventSchema.parse({ ...clusterEvent, raw: null }).attributes,
    {},
  );
});

test('telemetry rejects malformed events at the shared boundary', () => {
  for (const key of [
    'id',
    'timestamp',
    'clusterId',
    'raw',
    'kind',
    'level',
    'message',
  ]) {
    const missing = { ...events[0] };
    delete missing[key];
    assert.equal(telemetryEventSchema.safeParse(missing).success, false, key);
  }
  for (const patch of [
    { timestamp: 'not-a-date' },
    { timestamp: '2026-09-08T10:00:00' },
    { id: '  ' },
    { clusterId: '' },
    { namespace: '' },
    { level: 'invalid' },
    { kind: 'unknown' },
    { raw: undefined },
    { attributes: { callback: () => {} } },
  ]) {
    assert.equal(
      telemetryEventSchema.safeParse({ ...events[0], ...patch }).success,
      false,
    );
  }
  for (const value of [NaN, Infinity, '1']) {
    assert.equal(
      telemetryEventSchema.safeParse({ ...events[1], value }).success,
      false,
    );
  }
  assert.equal(
    telemetryEventSchema.safeParse({ ...events[2], count: 0 }).success,
    false,
  );
  assert.equal(
    telemetryEventSchema.safeParse({
      ...events[2],
      involvedObject: {
        ...events[2].involvedObject,
        clusterId: 'another-cluster',
      },
    }).success,
    false,
  );
});

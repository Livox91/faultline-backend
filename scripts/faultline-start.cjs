const { openSync, closeSync, unlinkSync, statSync } = require('node:fs');
const {
  root,
  localDirectory,
  resolve,
  existsSync,
  readFileSync,
  writeFileSync,
  parseEnv,
  run,
  spawn,
  requestJson,
} = require('./onboarding/lib.cjs');

const pidPath = resolve(localDirectory, 'faultline.pid');
const logPath = resolve(localDirectory, 'faultline.log');
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (!existsSync(resolve(root, '.env.infrastructure')))
  throw new Error('Faultline is not configured. Run: npm run setup');
if (existsSync(pidPath)) {
  const pid = Number(readFileSync(pidPath, 'utf8'));
  if (Number.isSafeInteger(pid) && alive(pid)) {
    console.log(`Faultline is already running (PID ${pid}).`);
    process.exit(0);
  }
}

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
try {
  run('node', ['scripts/bootstrap-infrastructure.cjs'], {
    inherit: true,
    timeout: 240_000,
  });
} catch (error) {
  try {
    run(
      'docker',
      [
        'compose',
        '--env-file',
        '.env.infrastructure',
        '-f',
        'compose.infrastructure.yml',
        'down',
      ],
      { inherit: true },
    );
  } catch {}
  throw error;
}

require('node:fs').mkdirSync(localDirectory, { recursive: true });
// Only inspect output from this launch when deciding whether billing webhooks started.
// The log is append-only and may contain successful (or failed) attempts from days ago.
const logStart = existsSync(logPath) ? statSync(logPath).size : 0;
const output = openSync(logPath, 'a');
const child = spawn(process.execPath, ['scripts/dev-pipeline.cjs'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', output, output],
  env: process.env,
  windowsHide: true,
});
child.unref();
closeSync(output);
writeFileSync(pidPath, String(child.pid), 'utf8');

(async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const services = await Promise.all(
        [3000, 3001, 3002, 3003].map((port) =>
          requestJson(`http://127.0.0.1:${port}/health/ready`, {
            timeout: 2_000,
          }),
        ),
      );
      if (services.every((item) => ['ok', 'degraded'].includes(item.status))) {
        const billingEnabled =
          parseEnv(resolve(root, 'apps/api/.env')).BILLING_ENABLED === 'true';
        if (billingEnabled) {
          const launchOutput = readFileSync(logPath)
            .subarray(logStart)
            .toString('utf8');
          if (!launchOutput.includes('"event":"stripe_webhooks_forwarding"'))
            throw new Error(
              `Applications are healthy, but Stripe webhook forwarding did not start. Inspect ${logPath}`,
            );
        }
        console.log(
          'Faultline API, ingestion, processor, and storage are ready.',
        );
        if (billingEnabled)
          console.log('Stripe webhook forwarding is active.');
        console.log(`Runtime log: ${logPath}`);
        return;
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(
    `Faultline did not become ready in 60 seconds. Inspect ${logPath}`,
  );
})().catch((error) => {
  try {
    if (process.platform === 'win32')
      run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
  try {
    unlinkSync(pidPath);
  } catch {}
  console.error(error.message);
  process.exitCode = 1;
});

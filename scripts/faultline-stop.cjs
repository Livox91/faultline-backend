const { unlinkSync } = require('node:fs');
const {
  root,
  localDirectory,
  resolve,
  existsSync,
  readFileSync,
  run,
} = require('./onboarding/lib.cjs');

const pidPath = resolve(localDirectory, 'faultline.pid');
if (existsSync(pidPath)) {
  const pid = Number(readFileSync(pidPath, 'utf8'));
  if (Number.isSafeInteger(pid)) {
    try {
      if (process.platform === 'win32')
        run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000 });
      else process.kill(-pid, 'SIGTERM');
      console.log('Faultline applications stopped.');
    } catch {
      console.log('Faultline application process was already stopped.');
    }
  }
  unlinkSync(pidPath);
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
  ],
  { inherit: true, timeout: 120_000 },
);
console.log('Infrastructure stopped. Persistent volumes were retained.');

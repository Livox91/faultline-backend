const {
  existsSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
} = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const destination = resolve(root, '.local/remote-kubeconfig');
const staged = resolve(root, '.local/remote-kubeconfig.pending');
const sourceArgument = process.argv[2];

function fail(message) {
  console.error(`\nKubeconfig import failed.\n\n${message}\n`);
  process.exitCode = 1;
}

if (!sourceArgument) {
  fail(
    'Pass the exported file path:\n\nnpm run cluster:import -- "C:\\path\\booknest-faultline-kubeconfig.yaml"',
  );
} else {
  const source = resolve(process.cwd(), sourceArgument);
  if (!existsSync(source)) {
    fail(`File not found: ${source}`);
  } else {
    const content = readFileSync(source, 'utf8');
    const required = [
      /^apiVersion:\s*v1\s*$/m,
      /^current-context:\s*\S+/m,
      /certificate-authority-data:\s*\S+/,
      /(?:client-certificate-data|token):\s*\S+/,
      /(?:client-key-data|token):\s*\S+/,
    ];
    if (required.some((pattern) => !pattern.test(content))) {
      fail(
        'The file is not a portable Kubernetes kubeconfig with embedded credentials.',
      );
    } else {
      mkdirSync(resolve(destination, '..'), { recursive: true });
      copyFileSync(source, staged);
      try {
        chmodSync(staged, 0o600);
      } catch {}

      const result = spawnSync(
        'kubectl',
        [
          '--kubeconfig',
          staged,
          'get',
          'nodes',
          '-o',
          'custom-columns=NAME:.metadata.name,STATUS:.status.conditions[-1].type',
          '--request-timeout=15s',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      if (result.error?.code === 'ENOENT') {
        unlinkSync(staged);
        fail('kubectl is not installed or is not available on PATH.');
      } else if (result.status !== 0) {
        unlinkSync(staged);
        fail(
          `kubectl could not use the imported configuration:\n${(
            result.stderr ||
            result.stdout ||
            result.error?.message ||
            ''
          ).trim()}`,
        );
      } else {
        copyFileSync(staged, destination);
        unlinkSync(staged);
        try {
          chmodSync(destination, 0o600);
        } catch {}
        console.log('\nKubernetes access imported and verified.\n');
        console.log(result.stdout.trim());
        console.log('\nFaultline will automatically use .local/remote-kubeconfig.');
        console.log('Next: npm run faultline:start');
      }
    }
  }
}

const { spawn, spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { dirname, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const localDirectory = resolve(root, '.local');
const statePath = resolve(localDirectory, 'onboarding.json');

function executable(name) {
  return name;
}

function run(command, args = [], options = {}) {
  let program = executable(command);
  let programArgs = args;
  if (process.platform === 'win32' && command === 'npm') {
    program = process.execPath;
    programArgs = [
      process.env.npm_execpath ||
        resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      ...args,
    ];
  }
  const result = spawnSync(program, programArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    input: options.input,
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim();
    const error = new Error(
      options.message ??
        `${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`,
    );
    error.status = result.status;
    throw error;
  }
  return (result.stdout ?? '').trim();
}

function parseEnv(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2];
  }
  return values;
}

function writePrivate(path, content, overwrite = false) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  if (!overwrite && existsSync(path)) return false;
  writeFileSync(path, content.replace(/\n/g, require('node:os').EOL), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return true;
}

function loadState() {
  if (!existsSync(statePath))
    throw new Error('Cluster is not registered. Run: npm run cluster:add');
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveState(state) {
  mkdirSync(localDirectory, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function parseArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) result[key] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith('--'))
      result[key] = values[++index];
    else result[key] = true;
  }
  return result;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeout ?? 5_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return body;
}

function publicEndpoint(endpoint) {
  return endpoint.replace(/\/$/, '');
}

function kubeArgs(state, ...args) {
  return [...(state.context ? ['--context', state.context] : []), ...args];
}

module.exports = {
  root,
  localDirectory,
  statePath,
  executable,
  run,
  parseEnv,
  writePrivate,
  loadState,
  saveState,
  parseArgs,
  requestJson,
  publicEndpoint,
  kubeArgs,
  spawn,
  existsSync,
  readFileSync,
  writeFileSync,
  resolve,
};

/**
 * Local webhook delivery, started with the backend.
 *
 * A payment is not what creates an account - the signed `checkout.session.completed`
 * webhook is. On a laptop Stripe cannot reach `localhost`, so without a forwarder a
 * test purchase succeeds, money moves, and nothing at all happens on this side. That
 * failure is silent and looks exactly like a bug in provisioning, which is why this
 * runs automatically rather than living in a README step someone forgets.
 *
 * Two things have to happen, in this order:
 *
 *   1. the signing secret has to be in `apps/api/.env` *before* the API loads, because
 *      `PlatformModule` reads configuration from that file with `skipProcessEnv: true` -
 *      exporting a variable would be read by nothing;
 *   2. the forwarder has to be running, as a child of this process, so it dies with it
 *      instead of outliving the backend and quietly holding the listener open.
 *
 * Nothing here is required for the backend to boot. A missing CLI, a signed-out CLI or
 * billing being switched off are all reported and stepped over - a developer who is not
 * working on payments should never be blocked by payment tooling.
 */
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { EOL } = require('node:os');

const API_ENV = resolve(__dirname, '../apps/api/.env');

/** Only what the API acts on. Anything else would be noise it already ignores. */
const FORWARDED_EVENTS = ['checkout.session.completed'];

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

/** `whsec_776f…` - enough to tell two secrets apart, never enough to sign with. */
const mask = (secret) =>
  typeof secret === 'string' && secret.length > 14
    ? `${secret.slice(0, 11)}…`
    : '(unset)';

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Rewrites one key in place.
 *
 * Line-by-line rather than re-serialising the file: this rewrites a developer's real
 * `.env`, and their comments, ordering and unrelated settings have to survive it.
 */
function setEnvValue(path, key, value) {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : EOL;
  const lines = original.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) {
    if (next.length && next[next.length - 1] === '') next.pop();
    next.push(`${key}=${value}`, '');
  }
  writeFileSync(path, next.join(eol), 'utf8');
}

/**
 * How to invoke the CLI on this machine.
 *
 * On Windows the Stripe CLI is usually an npm shim - `stripe.cmd` - and Node refuses to
 * spawn a `.cmd` without a shell, so a plain `spawn('stripe')` fails with ENOENT even
 * though the command works perfectly in a terminal. `STRIPE_CLI` overrides the whole
 * question for anyone with it installed somewhere unusual.
 */
const STRIPE_BIN = process.env.STRIPE_CLI || 'stripe';
const NEEDS_SHELL = process.platform === 'win32' && !/\.exe$/i.test(STRIPE_BIN);

/**
 * Through a shell, the command goes as one string with no argument array.
 *
 * Node deprecates passing `args` alongside `shell: true` because it concatenates them
 * without escaping. Every argument here is a constant or a port number this file
 * produced, so concatenating is safe - but it is done explicitly rather than left to
 * the deprecated path, and nothing from a request ever reaches it.
 */
const stripeSync = (args, options = {}) =>
  NEEDS_SHELL
    ? spawnSync([STRIPE_BIN, ...args].join(' '), {
        encoding: 'utf8',
        shell: true,
        ...options,
      })
    : spawnSync(STRIPE_BIN, args, { encoding: 'utf8', ...options });

function stripeAvailable() {
  const probe = stripeSync(['--version']);
  return !probe.error && probe.status === 0;
}

/**
 * The signing secret for this machine's listener.
 *
 * `--print-secret` answers without opening a stream, which is what makes it usable
 * before the API starts. The secret is stable per account and device, so this is
 * normally a no-op after the first run.
 */
function printSecret() {
  const result = stripeSync(['listen', '--print-secret']);
  if (result.status !== 0) {
    const reason = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    return { error: reason || 'stripe listen --print-secret failed' };
  }
  const secret = (result.stdout ?? '').trim().split(/\s+/).pop();
  if (!/^whsec_/.test(secret ?? ''))
    return { error: 'the CLI did not return a whsec_ secret' };
  return { secret };
}

/**
 * Puts the listener's secret in the file the API reads, and says whether it changed.
 *
 * A stale secret is the single most confusing failure in this flow: deliveries arrive,
 * signature verification rejects every one with a 401, and the purchase looks lost. So
 * the value is corrected rather than merely checked.
 */
function ensureWebhookSecret() {
  const env = readEnvFile(API_ENV);
  if (env.BILLING_ENABLED !== 'true')
    return { skipped: 'billing_disabled' };
  if (!stripeAvailable()) return { skipped: 'stripe_cli_not_installed' };

  const { secret, error } = printSecret();
  if (error) return { skipped: 'stripe_cli_not_ready', reason: error };

  const changed = env.STRIPE_WEBHOOK_SECRET !== secret;
  if (changed) setEnvValue(API_ENV, 'STRIPE_WEBHOOK_SECRET', secret);
  return { secret, changed };
}

/**
 * Starts the forwarder and hands back a stop function.
 *
 * Output is passed through as-is: when a delivery fails, the CLI's own message is what
 * a developer needs to read, and paraphrasing it would only lose detail.
 */
function startForwarder({ port = 3000, events = FORWARDED_EVENTS } = {}) {
  const target = `http://127.0.0.1:${port}/billing/webhook`;
  let stopped = false;
  const args = ['listen', '--forward-to', target, '--events', events.join(',')];
  const child = NEEDS_SHELL
    ? spawn([STRIPE_BIN, ...args].join(' '), {
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: true,
      })
    : spawn(STRIPE_BIN, args, { stdio: ['ignore', 'inherit', 'inherit'] });

  child.on('error', (error) =>
    log('stripe_listener_failed', { reason: error.message }),
  );
  child.on('exit', (code, signal) => {
    // A listener that dies quietly leaves purchases unprovisioned, so say so loudly.
    if (!stopped && code !== 0)
      log('stripe_listener_exited', { code, signal: signal ?? null });
  });

  return () => {
    if (stopped) return;
    stopped = true;
    // Through a shell the child is `cmd.exe`, and killing it would orphan the listener
    // it launched - which would then hold the stream open past the backend's exit.
    if (NEEDS_SHELL && child.pid)
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
      });
    else child.kill();
  };
}

/**
 * Everything, in order, for a process that is about to start the API.
 *
 * Returns a stop function - always safe to call, even when nothing was started.
 */
function startWebhookForwarding({ port = 3000 } = {}) {
  const outcome = ensureWebhookSecret();
  if (outcome.skipped) {
    if (outcome.skipped !== 'billing_disabled')
      log('stripe_webhooks_not_started', {
        reason: outcome.skipped,
        detail: outcome.reason ?? null,
        // Said plainly, because the consequence is not obvious from the reason.
        consequence:
          'test purchases will complete at Stripe but provision no account',
        remedy:
          outcome.skipped === 'stripe_cli_not_installed'
            ? 'install the Stripe CLI: https://stripe.com/docs/stripe-cli'
            : 'run: stripe login',
      });
    return () => {};
  }

  const stop = startForwarder({ port });
  log('stripe_webhooks_forwarding', {
    to: `http://127.0.0.1:${port}/billing/webhook`,
    events: FORWARDED_EVENTS,
    secret: mask(outcome.secret),
    // Worth knowing: the API reads the file at boot, so a rotation needs a restart.
    secret_updated: outcome.changed,
  });
  if (outcome.changed)
    log('stripe_webhook_secret_updated', {
      file: 'apps/api/.env',
      note: 'the API reads this at boot; restart if it was already running',
    });
  return stop;
}

module.exports = {
  ensureWebhookSecret,
  startForwarder,
  startWebhookForwarding,
  FORWARDED_EVENTS,
};

/* Standalone: `npm run webhooks`, for a backend started some other way. */
if (require.main === module) {
  const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);
  const stop = startWebhookForwarding({ port });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      stop();
      process.exit(0);
    });
}

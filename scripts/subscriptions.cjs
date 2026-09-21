/**
 * Subscription reconciliation.
 *
 * Provisioning can fail between a confirmed payment and a usable account: the database
 * blinks, SMTP is down, a username collides pathologically. The payment is always
 * recorded first, so nothing is lost - but somebody has to be able to see what is
 * outstanding and finish it. That is this.
 *
 *   npm run subscriptions:pending                       # what is unfinished, and why
 *   npm run subscriptions:resend -- --email a@b.c       # re-issue credentials
 *
 * `resend` issues a *new* temporary password and re-locks the account to the password
 * change. The old temporary password stops working, which is the right outcome: if the
 * first email did go out and was read by someone else, this takes it back.
 */
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { Client } = require('pg');
const {
  generateTemporaryPassword,
  hashPassword,
  allocateUsername,
} = require('@faultline/auth');
const { credentialsEmail, SmtpEmailSender } = require('@faultline/email');
const { PLANS } = require('@faultline/billing');

const root = resolve(__dirname, '..');

function parseEnv(path) {
  const values = {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const [key, inline] = value.slice(2).split('=');
      if (inline !== undefined) args[key] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith('--'))
        args[key] = argv[(index += 1)];
      else args[key] = true;
    } else args._.push(value);
  }
  return args;
}

const env = parseEnv(resolve(root, 'apps/api/.env'));

async function connect() {
  const connectionString = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!connectionString)
    throw new Error('Missing DATABASE_URL. Run: npm run setup');
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  const ready = await client.query(
    "SELECT to_regclass('public.subscriptions')::text AS subscriptions",
  );
  if (!ready.rows[0]?.subscriptions) {
    await client.end();
    throw new Error('The subscriptions table does not exist. Run: npm run db:migrate');
  }
  return client;
}

/**
 * Builds the same sender the API uses.
 *
 * Refuses to pretend: with the development log transport there is nowhere for a
 * re-issued credential to go, and printing it to a terminal is not delivery.
 */
function emailSender() {
  if ((env.EMAIL_TRANSPORT ?? 'log') !== 'smtp')
    throw new Error(
      'EMAIL_TRANSPORT is not smtp, so credentials cannot actually be delivered.\n' +
        'Configure SMTP in apps/api/.env before re-issuing credentials.',
    );
  if (!env.SMTP_HOST) throw new Error('SMTP_HOST is not configured');
  return new SmtpEmailSender({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === 'true',
    ...(env.SMTP_USERNAME ? { username: env.SMTP_USERNAME } : {}),
    ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
    from: env.EMAIL_FROM ?? 'Faultline <no-reply@faultline.local>',
  });
}

const commands = {
  /** Paid, but not finished. The queue an operator works through. */
  async pending(client) {
    const result = await client.query(
      `SELECT s.email, s.plan, s.status, s.provisioning_status, s.provisioning_error,
              s.checkout_session_id, s.created_at, u.username
         FROM subscriptions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.provisioning_status <> 'provisioned'
        ORDER BY s.created_at`,
    );
    if (!result.rows.length)
      return console.log('Nothing outstanding: every subscription is provisioned.');
    console.table(
      result.rows.map((row) => ({
        Email: row.email,
        Plan: row.plan,
        Payment: row.status,
        Provisioning: row.provisioning_status,
        Account: row.username ?? '(none)',
        Why: (row.provisioning_error ?? '').slice(0, 60) || '—',
        Since: row.created_at.toISOString(),
      })),
    );
    console.log(
      '\nRe-issue credentials with:\n  npm run subscriptions:resend -- --email <address>',
    );
  },

  /**
   * Re-issues credentials for a subscription whose account exists but whose email
   * never arrived, creating the account first if provisioning never got that far.
   */
  async resend(client, args) {
    const email = typeof args.email === 'string' ? args.email.trim() : '';
    if (!email) throw new Error('Pass --email <address>');

    const sender = emailSender();

    const found = await client.query(
      `SELECT s.id, s.plan, s.user_id, s.provisioning_status, u.username, u.email AS user_email
         FROM subscriptions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE lower(s.email) = lower($1)
        ORDER BY s.created_at DESC LIMIT 1`,
      [email],
    );
    const subscription = found.rows[0];
    if (!subscription)
      throw new Error(`No subscription recorded for ${email}`);

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    let username = subscription.username;
    let userId = subscription.user_id;

    if (!userId) {
      // The payment was recorded but the account never got made. Make it now.
      const isTaken = async (candidate) =>
        (
          await client.query(
            'SELECT 1 FROM users WHERE lower(username) = lower($1)',
            [candidate],
          )
        ).rowCount > 0;
      username = await allocateUsername(email.split('@')[0], isTaken);
      const created = await client.query(
        `INSERT INTO users (id, email, username, name, role, password_hash, status, must_change_password)
         VALUES (gen_random_uuid(), $1, $2, $3, 'admin', $4, 'active', true)
         RETURNING id`,
        [email.toLowerCase(), username, email.split('@')[0], passwordHash],
      );
      userId = created.rows[0].id;
      await client.query('UPDATE subscriptions SET user_id = $2 WHERE id = $1', [
        subscription.id,
        userId,
      ]);
      console.log(`Created the missing admin account ${username}.`);
    } else {
      // The account exists. Replacing the password invalidates whatever went out
      // before, which is the point when a credential may have gone astray.
      await client.query(
        `UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now()
          WHERE id = $1`,
        [userId, passwordHash],
      );
      console.log(`Re-issued the temporary password for ${username}.`);
    }

    await sender.send(
      credentialsEmail({
        applicationName: env.APP_NAME ?? 'Faultline',
        to: email,
        username,
        temporaryPassword,
        loginUrl: `${(env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, '')}/login`,
        planName: PLANS[subscription.plan]?.name ?? subscription.plan,
      }),
    );

    await client.query(
      `UPDATE subscriptions
          SET provisioning_status = 'provisioned', provisioning_error = NULL, updated_at = now()
        WHERE id = $1`,
      [subscription.id],
    );
    await client.query(
      `INSERT INTO audit_log (id, user_id, actor, action, resource_type, resource_id, outcome, metadata)
       VALUES (gen_random_uuid(), $1, 'cli', 'subscription.provisioned', 'subscription', $2, 'allowed', $3::jsonb)`,
      [userId, subscription.id, JSON.stringify({ reissued: true, username })],
    );
    console.log(`Credentials sent to ${email}.`);
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handler = commands[args._[0]];
  if (!handler) {
    console.error(
      `Usage: node scripts/subscriptions.cjs <${Object.keys(commands).join('|')}> [options]`,
    );
    process.exitCode = 1;
    return;
  }
  const client = await connect();
  try {
    await handler(client, args);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

/**
 * User and project-assignment administration from the command line.
 *
 * The API can do all of this, but it needs an Admin to be logged in first - and a fresh
 * deployment has none. This is the way in, and the way back in when the last Admin
 * password is lost. It writes the same tables the API reads, so an account created here
 * behaves identically to one created through the admin UI.
 *
 *   npm run user:create -- --email a@b.c --name "Ahmed" --role onsiteengineer --password "..."
 *   npm run user:list
 *   npm run user:assign -- --email a@b.c --project project-a
 *   npm run user:unassign -- --email a@b.c --project project-a
 *   npm run user:role -- --email a@b.c --role admin
 *   npm run user:password -- --email a@b.c --password "..."
 *   npm run user:disable -- --email a@b.c
 *   npm run user:enable -- --email a@b.c
 */
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { hashPassword, parseRole, ROLES } = require('@faultline/auth');

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
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
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

async function connect() {
  const env = parseEnv(resolve(root, 'apps/api/.env'));
  const connectionString = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!connectionString)
    throw new Error('Missing DATABASE_URL. Run: npm run setup');
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  // Fails loudly rather than half-working if migration 0005 has not been applied.
  const ready = await client.query(
    "SELECT to_regclass('public.users')::text AS users",
  );
  if (!ready.rows[0]?.users) {
    await client.end();
    throw new Error(
      'The users table does not exist. Run: npm run db:migrate',
    );
  }
  return client;
}

async function findUser(client, email) {
  const result = await client.query(
    'SELECT id, email, name, role, status FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  return result.rows[0];
}

function requireEmail(args) {
  if (typeof args.email !== 'string' || !args.email.includes('@'))
    throw new Error('Pass --email <address>');
  return args.email.trim();
}

/** Recorded from the CLI too: an out-of-band change is still a change worth seeing. */
async function audit(client, action, resourceType, resourceId, metadata = {}) {
  await client.query(
    `INSERT INTO audit_log (id, user_id, actor, action, resource_type, resource_id, outcome, metadata)
     VALUES ($1, NULL, $2, $3, $4, $5, 'allowed', $6::jsonb)`,
    [
      randomUUID(),
      'cli',
      action,
      resourceType,
      resourceId,
      JSON.stringify(metadata),
    ],
  );
}

const commands = {
  async create(client, args) {
    const email = requireEmail(args);
    const name = typeof args.name === 'string' ? args.name.trim() : email;
    const role = parseRole(args.role ?? ROLES.ONSITE_ENGINEER);
    if (!role)
      throw new Error(
        `Unknown role. Use one of: ${Object.values(ROLES).join(', ')}`,
      );
    if (typeof args.password !== 'string' || args.password.length < 12)
      throw new Error('Pass --password with at least 12 characters');

    const id = randomUUID();
    try {
      await client.query(
        `INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)`,
        [id, email.toLowerCase(), name, role, await hashPassword(args.password)],
      );
    } catch (error) {
      if (error.code === '23505')
        throw new Error(`A user with the email ${email} already exists`);
      throw error;
    }
    await audit(client, 'user.created', 'user', id, { email, role });
    console.log(`Created ${role} ${email} (${id})`);

    const projects = String(args.projects ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const project of projects)
      await commands.assign(client, { email, project });
  },

  async list(client) {
    const result = await client.query(
      `SELECT u.email, u.name, u.role, u.status,
              COALESCE(array_agg(pu.project_id ORDER BY pu.project_id)
                       FILTER (WHERE pu.project_id IS NOT NULL), '{}') AS projects
         FROM users u
         LEFT JOIN project_users pu ON pu.user_id = u.id
         GROUP BY u.id
         ORDER BY u.role, lower(u.email)`,
    );
    if (!result.rows.length) return console.log('No users yet.');
    const rows = result.rows.map((row) => ({
      Email: row.email,
      Name: row.name,
      Role: row.role,
      Status: row.status,
      // An Admin's reach is not a list of projects, and showing one would imply it is.
      Projects:
        row.role === ROLES.ADMIN
          ? 'All projects'
          : row.projects.join(', ') || '(none)',
    }));
    console.table(rows);
  },

  async assign(client, args) {
    const email = requireEmail(args);
    const project = args.project;
    if (typeof project !== 'string' || !project.trim())
      throw new Error('Pass --project <projectId>');
    const user = await findUser(client, email);
    if (!user) throw new Error(`No such user: ${email}`);
    const exists = await client.query('SELECT 1 FROM clusters WHERE id = $1', [
      project,
    ]);
    if (!exists.rowCount)
      throw new Error(
        `No such project: ${project}. Existing projects: run npm run user:list after onboarding a cluster.`,
      );
    if (user.role === ROLES.ADMIN)
      console.log(
        `Note: ${email} is an Admin and already reaches every project; the assignment is recorded but grants nothing extra.`,
      );
    await client.query(
      `INSERT INTO project_users (user_id, project_id) VALUES ($1, $2)
       ON CONFLICT (user_id, project_id) DO UPDATE SET assigned_at = now()`,
      [user.id, project],
    );
    await audit(client, 'project.assignment.created', 'project', project, {
      userId: user.id,
      email,
    });
    console.log(`Assigned ${email} to ${project}`);
  },

  async unassign(client, args) {
    const email = requireEmail(args);
    const user = await findUser(client, email);
    if (!user) throw new Error(`No such user: ${email}`);
    const result = await client.query(
      'DELETE FROM project_users WHERE user_id = $1 AND project_id = $2',
      [user.id, args.project],
    );
    if (!result.rowCount)
      throw new Error(`${email} is not assigned to ${args.project}`);
    await audit(
      client,
      'project.assignment.removed',
      'project',
      String(args.project),
      { userId: user.id, email },
    );
    console.log(`Removed ${email} from ${args.project}`);
  },

  async role(client, args) {
    const email = requireEmail(args);
    const role = parseRole(args.role);
    if (!role)
      throw new Error(
        `Unknown role. Use one of: ${Object.values(ROLES).join(', ')}`,
      );
    const user = await findUser(client, email);
    if (!user) throw new Error(`No such user: ${email}`);
    if (user.role === ROLES.ADMIN && role !== ROLES.ADMIN) {
      const admins = await client.query(
        "SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active'",
      );
      // Refusing here is the CLI's share of the same rule the API enforces: the system
      // must never end up with nobody who can administer it.
      if (admins.rows[0].count <= 1)
        throw new Error(
          'This is the last active Admin. Promote another user first.',
        );
    }
    await client.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [
      user.id,
      role,
    ]);
    await audit(client, 'user.role.changed', 'user', user.id, {
      from: user.role,
      to: role,
    });
    console.log(`${email} is now ${role}`);
  },

  async password(client, args) {
    const email = requireEmail(args);
    if (typeof args.password !== 'string' || args.password.length < 12)
      throw new Error('Pass --password with at least 12 characters');
    const user = await findUser(client, email);
    if (!user) throw new Error(`No such user: ${email}`);
    await client.query(
      'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
      [user.id, await hashPassword(args.password)],
    );
    await audit(client, 'user.modified', 'user', user.id, { field: 'password' });
    console.log(`Password updated for ${email}`);
  },

  disable: (client, args) => setStatus(client, args, 'disabled'),
  enable: (client, args) => setStatus(client, args, 'active'),
};

async function setStatus(client, args, status) {
  const email = requireEmail(args);
  const user = await findUser(client, email);
  if (!user) throw new Error(`No such user: ${email}`);
  if (status === 'disabled' && user.role === ROLES.ADMIN) {
    const admins = await client.query(
      "SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active'",
    );
    if (admins.rows[0].count <= 1)
      throw new Error('This is the last active Admin and cannot be disabled.');
  }
  await client.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [
    user.id,
    status,
  ]);
  await audit(client, 'user.modified', 'user', user.id, { status });
  console.log(`${email} is now ${status}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const handler = commands[command];
  if (!handler) {
    console.error(
      `Usage: node scripts/user.cjs <${Object.keys(commands).join('|')}> [options]`,
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

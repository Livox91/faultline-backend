import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

const migrationDirectory = resolve(__dirname, '../migrations');

export async function loadMigrations(): Promise<readonly Migration[]> {
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();
  const migrations = await Promise.all(
    files.map(async (file): Promise<Migration> => {
      const match = /^(\d+)_([a-z0-9_-]+)\.sql$/i.exec(file)!;
      const sql = await readFile(resolve(migrationDirectory, file), 'utf8');
      const parts = sql.split(/^-- migrate:down\s*$/im);
      const up = parts[0]!.replace(/^-- migrate:up\s*$/im, '').trim();
      const down = parts[1]?.trim();
      if (!up) throw new Error(`Migration ${file} has no up SQL`);
      return {
        version: Number(match[1]),
        name: match[2]!,
        up,
        ...(down ? { down } : {}),
      };
    }),
  );
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      versions.has(migration.version)
    )
      throw new Error(
        `Invalid or duplicate migration version: ${migration.version}`,
      );
    versions.add(migration.version);
  }
  return migrations;
}

export async function applyMigrations(pool: Pool): Promise<number[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (
      await pool.query<{ version: string }>(
        'SELECT version::text AS version FROM schema_migrations',
      )
    ).rows.map((row) => Number(row.version)),
  );
  const completed: number[] = [];
  for (const migration of await loadMigrations()) {
    if (applied.has(migration.version)) continue;
    await transaction(pool, async (client) => {
      await client.query(migration.up);
      await client.query(
        'INSERT INTO schema_migrations(version,name) VALUES ($1,$2)',
        [migration.version, migration.name],
      );
    });
    completed.push(migration.version);
  }
  return completed;
}

export async function rollbackMigration(
  pool: Pool,
): Promise<number | undefined> {
  const row = (
    await pool.query<{ version: string }>(
      'SELECT version::text AS version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    )
  ).rows[0];
  if (!row) return undefined;
  const version = Number(row.version);
  const migration = (await loadMigrations()).find(
    (item) => item.version === version,
  );
  if (!migration?.down)
    throw new Error(`Migration ${version} cannot be rolled back`);
  await transaction(pool, async (client) => {
    await client.query(migration.down!);
    await client.query('DELETE FROM schema_migrations WHERE version=$1', [
      version,
    ]);
  });
  return version;
}

async function transaction(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

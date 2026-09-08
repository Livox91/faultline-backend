import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresConnection } from './index';
import { applyMigrations, rollbackMigration } from './migrations';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'create') {
    const name = (process.argv[3] ?? '').replace(/[^a-z0-9_-]/gi, '_');
    if (!name) throw new Error('Usage: migration:create -- <name>');
    const directory = resolve(__dirname, '../migrations');
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, `${Date.now()}_${name}.sql`);
    await writeFile(file, '-- migrate:up\n\n-- migrate:down\n', { flag: 'wx' });
    console.log(file);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const database = new PostgresConnection(url);
  try {
    if (command === 'apply')
      console.log(
        JSON.stringify({ applied: await applyMigrations(database.pool) }),
      );
    else if (command === 'rollback')
      console.log(
        JSON.stringify({
          rolledBack: (await rollbackMigration(database.pool)) ?? null,
        }),
      );
    else throw new Error('Usage: migrate <create|apply|rollback>');
  } finally {
    await database.disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});

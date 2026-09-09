import { ClickHouseConnection } from './connection';

/**
 * Schema lifecycle entry point.
 *
 * Applying the ClickHouse schema is a deployment step, exactly like the PostgreSQL
 * migrations: no service creates tables on startup.
 */
function retentionDays(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1)
    throw new Error(`${name} must be a positive integer number of days`);
  return days;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error('CLICKHOUSE_URL is required');
  const connection = new ClickHouseConnection({
    url,
    ...(process.env.CLICKHOUSE_DATABASE
      ? { database: process.env.CLICKHOUSE_DATABASE }
      : {}),
    ...(process.env.CLICKHOUSE_USERNAME
      ? { username: process.env.CLICKHOUSE_USERNAME }
      : {}),
    ...(process.env.CLICKHOUSE_PASSWORD
      ? { password: process.env.CLICKHOUSE_PASSWORD }
      : {}),
    retention: {
      logsDays: retentionDays('TELEMETRY_RETENTION_LOGS_DAYS', 7),
      metricsDays: retentionDays('TELEMETRY_RETENTION_METRICS_DAYS', 14),
      kubernetesEventsDays: retentionDays(
        'TELEMETRY_RETENTION_KUBERNETES_EVENTS_DAYS',
        30,
      ),
    },
  });
  try {
    if (command === 'apply') {
      await connection.applySchema();
      console.log(
        JSON.stringify({
          applied: true,
          database: connection.options.database,
          retention: connection.options.retention,
        }),
      );
    } else if (command === 'retention') {
      await connection.applyRetention();
      console.log(JSON.stringify({ retention: connection.options.retention }));
    } else if (command === 'truncate') {
      await connection.truncateTelemetry();
      console.log(
        JSON.stringify({
          truncated: true,
          database: connection.options.database,
        }),
      );
    } else throw new Error('Usage: schema-cli <apply|retention|truncate>');
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'ClickHouse schema command failed',
  );
  process.exitCode = 1;
});

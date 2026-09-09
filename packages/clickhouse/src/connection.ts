import { createClient, type ClickHouseClient } from '@clickhouse/client';
import {
  defaultRetentionConfig,
  validateRetentionConfig,
  type TelemetryRetentionConfig,
} from '@faultline/telemetry';
import {
  createDatabaseStatement,
  quoteIdentifier,
  retentionStatements,
  schemaStatements,
  truncateStatements,
} from './schema';

export interface ClickHouseOptions {
  url: string;
  database?: string;
  username?: string;
  password?: string;
  requestTimeoutMs?: number;
  /** Rows per INSERT request; the batcher already bounds this, so it is a safety net. */
  maxInsertRows?: number;
  retention?: TelemetryRetentionConfig;
}

export interface ResolvedClickHouseOptions extends Required<
  Omit<ClickHouseOptions, 'password' | 'retention'>
> {
  password?: string;
  retention: TelemetryRetentionConfig;
}

export function resolveClickHouseOptions(
  options: ClickHouseOptions,
): ResolvedClickHouseOptions {
  const database = options.database ?? 'faultline';
  // Throws on an unusable name before any statement is built from it.
  quoteIdentifier(database);
  return {
    url: options.url,
    database,
    username: options.username ?? 'default',
    ...(options.password ? { password: options.password } : {}),
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    maxInsertRows: options.maxInsertRows ?? 10_000,
    retention: validateRetentionConfig({
      ...defaultRetentionConfig,
      ...options.retention,
    }),
  };
}

/**
 * Owns the ClickHouse client and the schema lifecycle.
 *
 * Kept separate from the store so health checks, the schema CLI and tests can use a
 * connection without pulling in query code, and so nothing outside this package needs
 * to import `@clickhouse/client`.
 */
export class ClickHouseConnection {
  readonly name = 'clickhouse';
  readonly options: ResolvedClickHouseOptions;
  readonly client: ClickHouseClient;

  constructor(options: ClickHouseOptions) {
    this.options = resolveClickHouseOptions(options);
    this.client = createClient({
      url: this.options.url,
      username: this.options.username,
      ...(this.options.password ? { password: this.options.password } : {}),
      request_timeout: this.options.requestTimeoutMs,
    });
  }

  /** Creates the database and tables if absent, then reconciles retention TTLs. */
  async applySchema(): Promise<void> {
    await this.client.command({
      query: createDatabaseStatement(this.options.database),
    });
    for (const query of schemaStatements({
      database: this.options.database,
      retention: this.options.retention,
    }))
      await this.client.command({ query });
  }

  /** Applies only the TTL changes; used when retention configuration changes. */
  async applyRetention(): Promise<void> {
    for (const query of retentionStatements({
      database: this.options.database,
      retention: this.options.retention,
    }))
      await this.client.command({ query });
  }

  /** Development helper: empties telemetry without dropping the schema. */
  async truncateTelemetry(): Promise<void> {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Refusing to truncate telemetry in production');
    for (const query of truncateStatements(this.options.database))
      await this.client.command({ query });
  }

  /** Readiness probe: proves the connection works and the schema has been applied. */
  async ping(): Promise<void> {
    const result = await this.client.query({
      query: `SELECT count() AS tables FROM system.tables WHERE database = {database:String} AND name IN ('telemetry_logs', 'telemetry_metrics', 'telemetry_kubernetes_events')`,
      query_params: { database: this.options.database },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ tables: string }>();
    if (Number(rows[0]?.tables ?? 0) !== 3)
      throw new Error('ClickHouse telemetry schema has not been applied');
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}

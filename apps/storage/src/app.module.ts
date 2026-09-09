import { Module, type Provider } from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  HealthService,
  PlatformModule,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  QUEUE,
  NatsJetStreamQueue,
  getDevelopmentQueue,
} from '@faultline/queue';
import {
  TELEMETRY_STORE,
  getDevelopmentTelemetryStore,
} from '@faultline/telemetry';
import {
  BASELINE_REPOSITORY,
  HISTORICAL_TELEMETRY_QUERY,
  getDevelopmentBaselineRepository,
} from '@faultline/baselines';
import {
  ClickHouseConnection,
  ClickHouseHistoricalTelemetry,
  ClickHouseTelemetryStore,
} from '@faultline/clickhouse';
import {
  DATABASE,
  PostgresBaselineRepository,
  PostgresConnection,
  PostgresIncidentRepository,
} from '@faultline/database';
import {
  INCIDENT_REPOSITORY,
  getDevelopmentIncidentRepository,
} from '@faultline/incidents';
import { resolve } from 'node:path';
import { TelemetryStorageConsumer } from './telemetry-storage.consumer';
import { BaselineRefreshService } from './baseline-refresh.service';

export const CLICKHOUSE_CONNECTION = Symbol('faultline.clickhouse-connection');

const testMode = process.env.NODE_ENV === 'test';
const providers: Provider[] = [
  TelemetryStorageConsumer,
  BaselineRefreshService,
];

if (testMode) {
  providers.push(
    { provide: QUEUE, useFactory: getDevelopmentQueue },
    // Shared with the API in test mode, so writes here are readable there.
    { provide: TELEMETRY_STORE, useFactory: getDevelopmentTelemetryStore },
    {
      provide: BASELINE_REPOSITORY,
      useFactory: getDevelopmentBaselineRepository,
    },
    {
      provide: INCIDENT_REPOSITORY,
      useFactory: getDevelopmentIncidentRepository,
    },
    {
      // Test mode has no telemetry history to derive from, so refresh finds no targets
      // and writes nothing rather than pretending a baseline exists.
      provide: HISTORICAL_TELEMETRY_QUERY,
      useFactory: () => ({
        listBaselineTargets: async () => [],
        summarizeMetric: async () => ({ sampleCount: 0 }),
        findDisruptionWindows: async () => [],
      }),
    },
  );
} else {
  providers.push(
    {
      provide: QUEUE,
      inject: [APPLICATION_CONFIG, HealthService],
      useFactory: async (config: ApplicationConfig, health: HealthService) => {
        const queue = await NatsJetStreamQueue.connect({
          servers: config.infrastructure.brokerUrl!,
          clientId: config.infrastructure.brokerClientId,
          consumerGroup: config.infrastructure.brokerConsumerGroup,
          maxDeliver: config.infrastructure.brokerMaxDeliver,
          retryDelayMs: config.infrastructure.brokerRetryDelayMs,
        });
        health.register(queue);
        return queue;
      },
    },
    {
      provide: CLICKHOUSE_CONNECTION,
      inject: [APPLICATION_CONFIG, HealthService],
      useFactory: async (config: ApplicationConfig, health: HealthService) => {
        const connection = new ClickHouseConnection({
          url: config.infrastructure.clickhouseUrl!,
          database: config.infrastructure.clickhouseDatabase,
          username: config.infrastructure.clickhouseUsername,
          ...(config.infrastructure.clickhousePassword
            ? { password: config.infrastructure.clickhousePassword }
            : {}),
          requestTimeoutMs: config.infrastructure.clickhouseRequestTimeoutMs,
          retention: config.telemetryStorage.retention,
        });
        // Schema application is a deployment step; startup only verifies it happened.
        await connection.ping();
        // Storage cannot do its job without ClickHouse, so here the probe is critical.
        health.register(connection);
        return connection;
      },
    },
    {
      provide: TELEMETRY_STORE,
      inject: [CLICKHOUSE_CONNECTION, APPLICATION_CONFIG],
      useFactory: (
        connection: ClickHouseConnection,
        config: ApplicationConfig,
      ) =>
        new ClickHouseTelemetryStore(connection, {
          queryLimits: config.telemetryStorage.queryLimits,
        }),
    },
    {
      provide: HISTORICAL_TELEMETRY_QUERY,
      inject: [CLICKHOUSE_CONNECTION],
      useFactory: (connection: ClickHouseConnection) =>
        new ClickHouseHistoricalTelemetry(connection),
    },
    {
      provide: DATABASE,
      inject: [APPLICATION_CONFIG, HealthService],
      useFactory: async (config: ApplicationConfig, health: HealthService) => {
        const database = new PostgresConnection(
          config.infrastructure.databaseUrl!,
        );
        await database.connect();
        health.register(database);
        return database;
      },
    },
    {
      // Derived baselines are control-plane state, so they live beside incidents.
      provide: BASELINE_REPOSITORY,
      inject: [DATABASE],
      useFactory: (database: PostgresConnection) =>
        new PostgresBaselineRepository(database),
    },
    {
      // Read-only here: incident windows are excluded from baseline calculation so an
      // outage never becomes this workload's definition of normal.
      provide: INCIDENT_REPOSITORY,
      inject: [DATABASE],
      useFactory: (database: PostgresConnection) =>
        new PostgresIncidentRepository(database),
    },
  );
}

@Module({
  providers,
  imports: [PlatformModule.forRoot('storage', resolve(__dirname, '../.env'))],
})
export class AppModule {}

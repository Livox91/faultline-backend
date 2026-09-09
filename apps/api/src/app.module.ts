import { Module, type Provider } from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  HealthService,
  PlatformModule,
  type ApplicationConfig,
} from '@faultline/platform';
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
import {
  BASELINE_REPOSITORY,
  getDevelopmentBaselineRepository,
} from '@faultline/baselines';
import {
  TELEMETRY_STORE,
  getDevelopmentTelemetryStore,
} from '@faultline/telemetry';
import {
  ClickHouseConnection,
  ClickHouseTelemetryStore,
} from '@faultline/clickhouse';
import { resolve } from 'node:path';
import { SystemController } from './system.controller';
import { IncidentsController } from './incidents.controller';
import { IncidentEvidenceController } from './incident-evidence.controller';
import { BaselinesController } from './baselines.controller';
import {
  ResourceTimelineController,
  TelemetryController,
} from './telemetry.controller';
import {
  ConfiguredTelemetryScopeResolver,
  TELEMETRY_SCOPE_RESOLVER,
} from './telemetry-scope';

export const CLICKHOUSE_CONNECTION = Symbol('faultline.clickhouse-connection');

const infrastructureProviders: Provider[] =
  process.env.NODE_ENV === 'test'
    ? [
        {
          provide: INCIDENT_REPOSITORY,
          useFactory: getDevelopmentIncidentRepository,
        },
        { provide: TELEMETRY_STORE, useFactory: getDevelopmentTelemetryStore },
        {
          provide: BASELINE_REPOSITORY,
          useFactory: getDevelopmentBaselineRepository,
        },
      ]
    : [
        {
          provide: DATABASE,
          inject: [APPLICATION_CONFIG, HealthService],
          useFactory: async (
            config: ApplicationConfig,
            health: HealthService,
          ) => {
            const database = new PostgresConnection(
              config.infrastructure.databaseUrl!,
            );
            await database.connect();
            health.register(database);
            return database;
          },
        },
        {
          provide: INCIDENT_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresIncidentRepository(database),
        },
        {
          // Baselines are served from PostgreSQL, so they stay inspectable even while
          // ClickHouse - and therefore refresh - is unavailable.
          provide: BASELINE_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresBaselineRepository(database),
        },
        {
          provide: CLICKHOUSE_CONNECTION,
          inject: [APPLICATION_CONFIG, HealthService],
          useFactory: async (
            config: ApplicationConfig,
            health: HealthService,
          ) => {
            const connection = new ClickHouseConnection({
              url: config.infrastructure.clickhouseUrl!,
              database: config.infrastructure.clickhouseDatabase,
              username: config.infrastructure.clickhouseUsername,
              ...(config.infrastructure.clickhousePassword
                ? { password: config.infrastructure.clickhousePassword }
                : {}),
              requestTimeoutMs:
                config.infrastructure.clickhouseRequestTimeoutMs,
              retention: config.telemetryStorage.retention,
            });
            // Non-critical: incidents stay readable while telemetry history is down,
            // and readiness reports the degradation instead of failing outright.
            health.register(connection, { critical: false });
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
      ];

@Module({
  imports: [PlatformModule.forRoot('api', resolve(__dirname, '../.env'))],
  controllers: [
    SystemController,
    IncidentsController,
    IncidentEvidenceController,
    TelemetryController,
    ResourceTimelineController,
    BaselinesController,
  ],
  providers: [
    ...infrastructureProviders,
    {
      provide: TELEMETRY_SCOPE_RESOLVER,
      useClass: ConfiguredTelemetryScopeResolver,
    },
  ],
})
export class AppModule {}

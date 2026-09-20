import { Module, SetMetadata, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  APPLICATION_CONFIG,
  HealthController,
  HealthService,
  PlatformModule,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  DATABASE,
  PostgresAuditLogRepository,
  PostgresBaselineRepository,
  PostgresClusterDirectory,
  PostgresConnection,
  PostgresIncidentRepository,
  PostgresProjectAssignmentRepository,
  PostgresUserRepository,
} from '@faultline/database';
import {
  AUDIT_LOG_REPOSITORY,
  PROJECT_ASSIGNMENT_REPOSITORY,
  USER_REPOSITORY,
  getDevelopmentAuditLogRepository,
  getDevelopmentProjectAssignmentRepository,
  getDevelopmentUserRepository,
} from '@faultline/auth';
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
  TELEMETRY_SCOPE_RESOLVER,
  UserTelemetryScopeResolver,
} from './telemetry-scope';
import { CLUSTER_DIRECTORY, ClustersController } from './clusters.controller';
import { IS_PUBLIC } from './auth/context';
import { AuthenticationGuard } from './auth/authentication.guard';
import { AuthorizationGuard } from './auth/authorization.guard';
import { AuditTrail } from './auth/audit-trail';
import { AdminBootstrap } from './auth/bootstrap';
import { AuthController, LoginThrottle } from './auth/auth.controller';
import { AdminUsersController } from './auth/users.controller';
import { AdminAuditController } from './auth/audit.controller';

export const CLICKHOUSE_CONNECTION = Symbol('faultline.clickhouse-connection');

/**
 * Liveness and readiness stay reachable without a token.
 *
 * The health controller ships in `@faultline/platform`, which knows nothing about
 * authorization and should not start to. Applying the metadata from here keeps that
 * separation while still letting the global guard see the exemption - a decorator is
 * just a function, and this is the one place that decides what is public.
 */
SetMetadata(IS_PUBLIC, true)(HealthController);

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
        { provide: USER_REPOSITORY, useFactory: getDevelopmentUserRepository },
        {
          provide: PROJECT_ASSIGNMENT_REPOSITORY,
          useFactory: getDevelopmentProjectAssignmentRepository,
        },
        {
          provide: AUDIT_LOG_REPOSITORY,
          useFactory: getDevelopmentAuditLogRepository,
        },
        {
          provide: CLUSTER_DIRECTORY,
          useValue: {
            list: async () => [],
            get: async () => undefined,
            create: async () => {
              throw new Error('Not available in tests');
            },
            update: async () => undefined,
            remove: async () => false,
          },
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
          provide: USER_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresUserRepository(database),
        },
        {
          provide: PROJECT_ASSIGNMENT_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresProjectAssignmentRepository(database),
        },
        {
          provide: AUDIT_LOG_REPOSITORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresAuditLogRepository(database),
        },
        {
          provide: CLUSTER_DIRECTORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) =>
            new PostgresClusterDirectory(database),
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
    AuthController,
    AdminUsersController,
    AdminAuditController,
    SystemController,
    IncidentsController,
    IncidentEvidenceController,
    TelemetryController,
    ResourceTimelineController,
    BaselinesController,
    ClustersController,
  ],
  providers: [
    ...infrastructureProviders,
    AuditTrail,
    LoginThrottle,
    AdminBootstrap,
    {
      provide: TELEMETRY_SCOPE_RESOLVER,
      useClass: UserTelemetryScopeResolver,
    },
    // Registered globally and in this order: authentication establishes who is calling
    // and rejects with 401, then authorization decides what they may reach and rejects
    // with 403. Global rather than per-controller so that a route added later is
    // protected unless it is explicitly marked `@Public()` - the failure mode of a
    // forgotten decorator is a locked door, not an open one.
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
})
export class AppModule {}

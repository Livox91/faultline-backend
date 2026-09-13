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
import {
  CLUSTER_DIRECTORY,
  ClustersController,
  type RegisteredCluster,
} from './clusters.controller';

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
        { provide: CLUSTER_DIRECTORY, useValue: { list: async () => [] } },
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
          provide: CLUSTER_DIRECTORY,
          inject: [DATABASE],
          useFactory: (database: PostgresConnection) => ({
            list: async (): Promise<RegisteredCluster[]> => {
              const result = await database.pool.query<{
                id: string;
                name: string;
                kubernetes_context: string | null;
                workload_namespace: string | null;
                workload_selector: string | null;
                created_at: Date;
                updated_at: Date;
                total: string;
                open: string;
                critical: string;
                last_seen: Date | null;
              }>(
                `SELECT c.id, COALESCE(c.name, c.id) AS name,
                        c.kubernetes_context, c.workload_namespace,
                        c.workload_selector, c.created_at, c.updated_at,
                        count(i.id)::text AS total,
                        count(i.id) FILTER (WHERE i.status <> 'RESOLVED')::text AS open,
                        count(i.id) FILTER (WHERE i.severity = 'CRITICAL')::text AS critical,
                        max(i.last_seen) AS last_seen
                 FROM clusters c
                 LEFT JOIN incidents i ON i.cluster_id = c.id
                 GROUP BY c.id
                 ORDER BY COALESCE(c.name, c.id), c.id`,
              );
              return result.rows.map((row) => ({
                id: row.id,
                name: row.name,
                ...(row.kubernetes_context
                  ? { kubernetesContext: row.kubernetes_context }
                  : {}),
                ...(row.workload_namespace
                  ? { workloadNamespace: row.workload_namespace }
                  : {}),
                ...(row.workload_selector
                  ? { workloadSelector: row.workload_selector }
                  : {}),
                createdAt: row.created_at.toISOString(),
                updatedAt: row.updated_at.toISOString(),
                total: Number(row.total),
                open: Number(row.open),
                critical: Number(row.critical),
                ...(row.last_seen
                  ? { lastSeen: row.last_seen.toISOString() }
                  : {}),
              }));
            },
          }),
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
    ClustersController,
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

import { Module } from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  HealthService,
  PlatformModule,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  DATABASE,
  PostgresConnection,
  PostgresIncidentRepository,
} from '@faultline/database';
import {
  INCIDENT_REPOSITORY,
  getDevelopmentIncidentRepository,
} from '@faultline/incidents';
import { resolve } from 'node:path';
import { SystemController } from './system.controller';
import { IncidentsController } from './incidents.controller';

const infrastructureProviders =
  process.env.NODE_ENV === 'test'
    ? [
        {
          provide: INCIDENT_REPOSITORY,
          useFactory: getDevelopmentIncidentRepository,
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
      ];

@Module({
  imports: [PlatformModule.forRoot('api', resolve(__dirname, '../.env'))],
  controllers: [SystemController, IncidentsController],
  providers: infrastructureProviders,
})
export class AppModule {}

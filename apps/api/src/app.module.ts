import { Module } from '@nestjs/common';
import { PlatformModule } from '@faultline/platform';
import { resolve } from 'node:path';
import { SystemController } from './system.controller';
import {
  INCIDENT_REPOSITORY,
  getDevelopmentIncidentRepository,
} from '@faultline/incidents';
import { IncidentsController } from './incidents.controller';

@Module({
  imports: [PlatformModule.forRoot('api', resolve(__dirname, '../.env'))],
  controllers: [SystemController, IncidentsController],
  providers: [
    {
      provide: INCIDENT_REPOSITORY,
      useFactory: getDevelopmentIncidentRepository,
    },
  ],
})
export class AppModule {}

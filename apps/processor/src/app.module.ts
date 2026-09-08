import { RESOURCE_STATE } from './resource-state/resource-state';
import { InMemoryResourceState } from './resource-state/in-memory-resource-state';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';
import { RULE_ENGINE } from './rules/contracts';
import { InMemoryRuleEngine } from './rules/in-memory-rule-engine';
import { createDefaultRules } from './rules/rules';
import { TelemetryConsumer } from './telemetry.consumer';
import { QUEUE, getDevelopmentQueue } from '@faultline/queue';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@faultline/platform';
import { resolve } from 'node:path';
import {
  INCIDENT_REPOSITORY,
  getDevelopmentIncidentRepository,
} from '@faultline/incidents';
import { INCIDENT_CORRELATOR } from './correlation/contracts';
import { IncidentCorrelationEngine } from './correlation/incident-correlation-engine';

@Module({
  providers: [
    { provide: QUEUE, useFactory: getDevelopmentQueue },
    TelemetryConsumer,
    { provide: RESOURCE_STATE, useFactory: () => new InMemoryResourceState() },
    {
      provide: INCIDENT_REPOSITORY,
      useFactory: getDevelopmentIncidentRepository,
    },
    {
      provide: RULE_ENGINE,
      inject: [APPLICATION_CONFIG],
      useFactory: (config: ApplicationConfig) =>
        new InMemoryRuleEngine(createDefaultRules(), config.anomalyThresholds),
    },
    {
      provide: INCIDENT_CORRELATOR,
      inject: [INCIDENT_REPOSITORY, APPLICATION_CONFIG],
      useFactory: (
        repository: import('@faultline/incidents').IncidentRepository,
        config: ApplicationConfig,
      ) =>
        new IncidentCorrelationEngine(repository, config.incidentCorrelation),
    },
  ],
  imports: [PlatformModule.forRoot('processor', resolve(__dirname, '../.env'))],
})
export class AppModule {}

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
  DATABASE,
  PostgresConnection,
  PostgresIncidentRepository,
} from '@faultline/database';
import {
  INCIDENT_REPOSITORY,
  getDevelopmentIncidentRepository,
  type IncidentRepository,
} from '@faultline/incidents';
import { resolve } from 'node:path';
import { RESOURCE_STATE } from './resource-state/resource-state';
import { InMemoryResourceState } from './resource-state/in-memory-resource-state';
import { RedisResourceState } from './resource-state/redis-resource-state';
import { RULE_ENGINE } from './rules/contracts';
import { InMemoryRuleEngine } from './rules/in-memory-rule-engine';
import { RedisRuleEngine } from './rules/redis-rule-engine';
import { createDefaultRules } from './rules/rules';
import { TelemetryConsumer } from './telemetry.consumer';
import { INCIDENT_CORRELATOR } from './correlation/contracts';
import { IncidentCorrelationEngine } from './correlation/incident-correlation-engine';
import {
  PROCESSING_LEDGER,
  RedisConnection,
  RedisProcessingLedger,
} from './infrastructure/redis';

export const REDIS_CONNECTION = Symbol('faultline.redis');
const testMode = process.env.NODE_ENV === 'test';
const providers: Provider[] = [TelemetryConsumer];

if (testMode) {
  providers.push(
    { provide: QUEUE, useFactory: getDevelopmentQueue },
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
      provide: INCIDENT_REPOSITORY,
      inject: [DATABASE],
      useFactory: (database: PostgresConnection) =>
        new PostgresIncidentRepository(database),
    },
    {
      provide: REDIS_CONNECTION,
      inject: [APPLICATION_CONFIG, HealthService],
      useFactory: async (config: ApplicationConfig, health: HealthService) => {
        const redis = new RedisConnection(config.infrastructure.redisUrl!);
        await redis.connect();
        health.register(redis);
        return redis;
      },
    },
    {
      provide: RESOURCE_STATE,
      inject: [REDIS_CONNECTION, APPLICATION_CONFIG],
      useFactory: (redis: RedisConnection, config: ApplicationConfig) =>
        new RedisResourceState(redis, config.infrastructure.resourceStateTtlMs),
    },
    {
      provide: PROCESSING_LEDGER,
      inject: [REDIS_CONNECTION],
      useFactory: (redis: RedisConnection) => new RedisProcessingLedger(redis),
    },
    {
      provide: RULE_ENGINE,
      inject: [REDIS_CONNECTION, APPLICATION_CONFIG],
      useFactory: (redis: RedisConnection, config: ApplicationConfig) =>
        new RedisRuleEngine(
          redis,
          new InMemoryRuleEngine(
            createDefaultRules(),
            config.anomalyThresholds,
          ),
        ),
    },
  );
}

providers.push({
  provide: INCIDENT_CORRELATOR,
  inject: [INCIDENT_REPOSITORY, APPLICATION_CONFIG],
  useFactory: (repository: IncidentRepository, config: ApplicationConfig) =>
    new IncidentCorrelationEngine(repository, config.incidentCorrelation),
});

@Module({
  providers,
  imports: [PlatformModule.forRoot('processor', resolve(__dirname, '../.env'))],
})
export class AppModule {}

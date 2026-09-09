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
  PostgresBaselineRepository,
  PostgresConnection,
  PostgresIncidentRepository,
} from '@faultline/database';
import {
  INCIDENT_REPOSITORY,
  getDevelopmentIncidentRepository,
  type IncidentRepository,
} from '@faultline/incidents';
import {
  BASELINE_PROVIDER,
  BASELINE_REPOSITORY,
  CachedBaselineProvider,
  getDevelopmentBaselineRepository,
  type BaselineProvider,
  type BaselineRepository,
} from '@faultline/baselines';
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
import { STATISTICAL_DETECTOR } from './statistical/contracts';
import { InMemoryStatisticalDetector } from './statistical/statistical-detector';
import { RedisStatisticalDetector } from './statistical/redis-statistical-detector';

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
    {
      provide: BASELINE_REPOSITORY,
      useFactory: getDevelopmentBaselineRepository,
    },
    {
      provide: STATISTICAL_DETECTOR,
      inject: [BASELINE_PROVIDER, APPLICATION_CONFIG],
      useFactory: (provider: BaselineProvider, config: ApplicationConfig) =>
        new InMemoryStatisticalDetector(provider, config.statisticalDetection),
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
    {
      // Baselines are read from PostgreSQL, never from ClickHouse: the processor must
      // keep detecting deviations while telemetry history is unavailable.
      provide: BASELINE_REPOSITORY,
      inject: [DATABASE],
      useFactory: (database: PostgresConnection) =>
        new PostgresBaselineRepository(database),
    },
    {
      provide: STATISTICAL_DETECTOR,
      inject: [REDIS_CONNECTION, BASELINE_PROVIDER, APPLICATION_CONFIG],
      useFactory: (
        redis: RedisConnection,
        provider: BaselineProvider,
        config: ApplicationConfig,
      ) =>
        new RedisStatisticalDetector(
          redis,
          new InMemoryStatisticalDetector(
            provider,
            config.statisticalDetection,
          ),
        ),
    },
  );
}

providers.push({
  provide: BASELINE_PROVIDER,
  inject: [BASELINE_REPOSITORY, APPLICATION_CONFIG],
  useFactory: (repository: BaselineRepository, config: ApplicationConfig) =>
    new CachedBaselineProvider(repository, config.baselines.cacheTtlMs),
});

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

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
  ClickHouseConnection,
  ClickHouseTelemetryStore,
} from '@faultline/clickhouse';
import { resolve } from 'node:path';
import { TelemetryStorageConsumer } from './telemetry-storage.consumer';

export const CLICKHOUSE_CONNECTION = Symbol('faultline.clickhouse-connection');

const testMode = process.env.NODE_ENV === 'test';
const providers: Provider[] = [TelemetryStorageConsumer];

if (testMode) {
  providers.push(
    { provide: QUEUE, useFactory: getDevelopmentQueue },
    // Shared with the API in test mode, so writes here are readable there.
    { provide: TELEMETRY_STORE, useFactory: getDevelopmentTelemetryStore },
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
  );
}

@Module({
  providers,
  imports: [PlatformModule.forRoot('storage', resolve(__dirname, '../.env'))],
})
export class AppModule {}

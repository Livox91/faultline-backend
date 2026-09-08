import { Module } from '@nestjs/common';
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
import { resolve } from 'node:path';
import { OtlpController } from './otlp/otlp.controller';
import {
  TelemetryController,
  CLUSTER_AUTHENTICATOR,
  DevelopmentClusterAuthenticator,
} from './telemetry.controller';

const queueProvider =
  process.env.NODE_ENV === 'test'
    ? { provide: QUEUE, useFactory: getDevelopmentQueue }
    : {
        provide: QUEUE,
        inject: [APPLICATION_CONFIG, HealthService],
        useFactory: async (
          config: ApplicationConfig,
          health: HealthService,
        ) => {
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
      };

@Module({
  controllers: [TelemetryController, OtlpController],
  providers: [
    queueProvider,
    {
      provide: CLUSTER_AUTHENTICATOR,
      useClass: DevelopmentClusterAuthenticator,
    },
  ],
  imports: [PlatformModule.forRoot('ingestion', resolve(__dirname, '../.env'))],
})
export class AppModule {}

import {
  TelemetryController,
  CLUSTER_AUTHENTICATOR,
  DevelopmentClusterAuthenticator,
} from './telemetry.controller';
import { QUEUE, getDevelopmentQueue } from '@faultline/queue';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@faultline/platform';
import { resolve } from 'node:path';

@Module({
  controllers: [TelemetryController],
  providers: [
    { provide: QUEUE, useFactory: getDevelopmentQueue },
    {
      provide: CLUSTER_AUTHENTICATOR,
      useClass: DevelopmentClusterAuthenticator,
    },
  ],
  imports: [PlatformModule.forRoot('ingestion', resolve(__dirname, '../.env'))],
})
export class AppModule {}

import { TelemetryConsumer } from './telemetry.consumer';
import { QUEUE, getDevelopmentQueue } from '@faultline/queue';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@faultline/platform';
import { resolve } from 'node:path';

@Module({
  providers: [
    { provide: QUEUE, useFactory: getDevelopmentQueue },
    TelemetryConsumer,
  ],
  imports: [PlatformModule.forRoot('processor', resolve(__dirname, '../.env'))],
})
export class AppModule {}

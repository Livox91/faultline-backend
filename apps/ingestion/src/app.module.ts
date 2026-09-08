import { Module } from '@nestjs/common';
import { PlatformModule } from '@faultline/platform';
import { resolve } from 'node:path';

@Module({
  imports: [PlatformModule.forRoot('ingestion', resolve(__dirname, '../.env'))],
})
export class AppModule {}

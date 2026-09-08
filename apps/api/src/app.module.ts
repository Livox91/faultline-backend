import { Module } from '@nestjs/common';
import { PlatformModule } from '@faultline/platform';
import { resolve } from 'node:path';
import { SystemController } from './system.controller';

@Module({
  imports: [PlatformModule.forRoot('api', resolve(__dirname, '../.env'))],
  controllers: [SystemController],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { PlatformModule } from '@faultline/platform';
import { resolve } from 'node:path';

@Module({
  imports: [PlatformModule.forRoot('processor', resolve(__dirname, '../.env'))],
})
export class AppModule {}

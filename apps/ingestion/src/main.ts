import 'reflect-metadata';
import { startApplication } from '@faultline/platform';

void startApplication(
  'ingestion',
  async () => (await import('./app.module.js')).AppModule,
);

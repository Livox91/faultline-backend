import 'reflect-metadata';
import { startApplication } from '@faultline/platform';

void startApplication(
  'api',
  async () => (await import('./app.module.js')).AppModule,
);

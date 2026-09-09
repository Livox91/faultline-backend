import 'reflect-metadata';
import { startApplication } from '@faultline/platform';

void startApplication(
  'storage',
  async () => (await import('./app.module.js')).AppModule,
);

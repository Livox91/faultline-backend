import 'reflect-metadata';
import { startApplication } from '@faultline/platform';
void startApplication(
  'notification',
  async () => (await import('./app.module.js')).AppModule,
  undefined,
  true,
);

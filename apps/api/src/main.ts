import 'reflect-metadata';
import { startApplication } from '@faultline/platform';

void startApplication(
  'api',
  async () => (await import('./app.module.js')).AppModule,
  undefined,
  // Payment webhooks are verified against the exact bytes the provider signed.
  { rawBody: true },
);

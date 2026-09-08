import 'reflect-metadata';
import { startApplication } from '@faultline/platform';

void startApplication('processor', async () => (await import('./app.module.js')).AppModule);

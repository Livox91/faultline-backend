import { type INestApplication, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
  type ApplicationName,
} from './config';
import { ApplicationLogger } from './logger';

export async function startApplication(
  application: ApplicationName,
  loadModule: () => Promise<Type<unknown>>,
): Promise<void> {
  const startupLogger = new ApplicationLogger(application);
  let app: INestApplication | undefined;
  try {
    // Load inside the error boundary so module/configuration failures use JSON too.
    const module = await loadModule();
    app = await NestFactory.create(module, {
      logger: startupLogger,
      bufferLogs: true,
      abortOnError: false,
    });
    const config = app.get<ApplicationConfig>(APPLICATION_CONFIG);
    const logger = app.get(ApplicationLogger);
    app.useLogger(logger);
    app.enableShutdownHooks();
    await app.listen(config.port, config.host);
    logger.log({ event: 'application_started', port: config.port });
  } catch (error: unknown) {
    startupLogger.error(
      error instanceof Error ? error.message : 'Application startup failed',
    );
    if (app) await app.close();
    process.exitCode = 1;
  }
}

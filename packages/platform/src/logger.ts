import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { logLevels, type ApplicationName } from './config';

/** Reusable through Nest injection or directly from shared infrastructure code. */
export class ApplicationLogger extends ConsoleLogger {
  constructor(
    private readonly application: ApplicationName,
    level: LogLevel = 'log',
  ) {
    super(application, {
      json: true,
      colors: false,
      logLevels: logLevels.slice(0, logLevels.indexOf(level) + 1),
    });
  }

  protected override getJsonLogObject(
    message: unknown,
    options: Parameters<ConsoleLogger['getJsonLogObject']>[1],
  ) {
    return {
      ...super.getJsonLogObject(message, options),
      // Always preserve app identity even when Nest supplies a class context.
      application: this.application,
    };
  }
}

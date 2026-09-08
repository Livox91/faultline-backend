import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  APPLICATION_CONFIG,
  applicationDefinitions,
  validateEnvironment,
  type ApplicationConfig,
  type ApplicationName,
  type Environment,
} from './config';
import { ApplicationLogger } from './logger';
import { HealthController, HealthService } from './health';

@Global()
@Module({})
export class PlatformModule {
  static forRoot(
    application: ApplicationName,
    envFilePath: string,
  ): DynamicModule {
    return {
      module: PlatformModule,
      imports: [
        ConfigModule.forRoot({
          cache: true,
          skipProcessEnv: true,
          envFilePath,
          validate: (values: Record<string, unknown>) =>
            validateEnvironment(application, values),
        }),
      ],
      controllers: [HealthController],
      providers: [
        {
          provide: APPLICATION_CONFIG,
          inject: [ConfigService],
          useFactory: (
            config: ConfigService<Environment, true>,
          ): ApplicationConfig =>
            Object.freeze({
              developmentAgentToken: config.get('FAULTLINE_DEV_AGENT_TOKEN', {
                infer: true,
              }),
              application,
              environment: config.get('NODE_ENV', { infer: true }),
              version: config.get('APP_VERSION', { infer: true }),
              host: config.get('HOST', { infer: true }),
              port: config.get('PORT', { infer: true }),
              logLevel: config.get('LOG_LEVEL', { infer: true }),
              enabledComponents: Object.freeze([
                ...applicationDefinitions[application].components,
              ]),
            }),
        },
        {
          provide: ApplicationLogger,
          inject: [APPLICATION_CONFIG],
          useFactory: (config: ApplicationConfig) =>
            new ApplicationLogger(application, config.logLevel),
        },
        HealthService,
      ],
      exports: [APPLICATION_CONFIG, ApplicationLogger, HealthService],
    };
  }
}

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
              anomalyThresholds: Object.freeze({
                memoryWarningPercent: config.get(
                  'ANOMALY_MEMORY_WARNING_PERCENT',
                  { infer: true },
                ),
                memoryCriticalPercent: config.get(
                  'ANOMALY_MEMORY_CRITICAL_PERCENT',
                  { infer: true },
                ),
                cpuWarningPercent: config.get('ANOMALY_CPU_WARNING_PERCENT', {
                  infer: true,
                }),
                cpuCriticalPercent: config.get('ANOMALY_CPU_CRITICAL_PERCENT', {
                  infer: true,
                }),
                restartThreshold: config.get('ANOMALY_RESTART_THRESHOLD', {
                  infer: true,
                }),
                notReadyDurationMs: config.get(
                  'ANOMALY_NOT_READY_DURATION_MS',
                  { infer: true },
                ),
                deploymentDegradationDurationMs: config.get(
                  'ANOMALY_DEPLOYMENT_DEGRADATION_DURATION_MS',
                  { infer: true },
                ),
              }),
              incidentCorrelation: Object.freeze({
                correlationWindowMs: config.get(
                  'INCIDENT_CORRELATION_WINDOW_MS',
                  { infer: true },
                ),
                stabilizationPeriodMs: config.get(
                  'INCIDENT_STABILIZATION_PERIOD_MS',
                  { infer: true },
                ),
              }),
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

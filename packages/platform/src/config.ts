import { z } from 'zod';

export const applicationDefinitions = {
  api: {
    port: 3000,
    components: [
      'configuration',
      'logging',
      'health',
      'system-info',
      'incidents',
    ],
  },
  ingestion: { port: 3001, components: ['configuration', 'logging', 'health'] },
  processor: {
    port: 3002,
    components: [
      'configuration',
      'logging',
      'health',
      'resource-state',
      'rule-engine',
      'incident-correlation',
    ],
  },
} as const;

export type ApplicationName = keyof typeof applicationDefinitions;
export const logLevels = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
] as const;

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    APP_VERSION: z.string().trim().min(1),
    HOST: z.string().trim().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535),
    LOG_LEVEL: z.enum(logLevels).default('log'),
    FAULTLINE_DEV_AGENT_TOKEN: z.string().min(1).optional(),
    DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url().optional(),
    BROKER_URL: z.string().url().optional(),
    BROKER_CLIENT_ID: z.string().trim().min(1).default('faultline'),
    BROKER_CONSUMER_GROUP: z
      .string()
      .trim()
      .min(1)
      .default('faultline-processors'),
    BROKER_MAX_DELIVER: z.coerce.number().int().min(1).max(100).default(5),
    BROKER_RETRY_DELAY_MS: z.coerce.number().int().min(100).default(1000),
    RESOURCE_STATE_TTL_MS: z.coerce.number().int().min(1000).default(120000),
    ANOMALY_MEMORY_WARNING_PERCENT: z.coerce
      .number()
      .min(1)
      .max(100)
      .default(85),
    ANOMALY_MEMORY_CRITICAL_PERCENT: z.coerce
      .number()
      .min(1)
      .max(100)
      .default(95),
    ANOMALY_CPU_WARNING_PERCENT: z.coerce.number().min(1).max(100).default(80),
    ANOMALY_CPU_CRITICAL_PERCENT: z.coerce.number().min(1).max(100).default(95),
    ANOMALY_RESTART_THRESHOLD: z.coerce.number().int().min(2).default(3),
    ANOMALY_NOT_READY_DURATION_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(60000),
    ANOMALY_DEPLOYMENT_DEGRADATION_DURATION_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(120000),
    INCIDENT_CORRELATION_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(600000),
    INCIDENT_STABILIZATION_PERIOD_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(120000),
  })
  .superRefine((value, context) => {
    if (
      value.ANOMALY_MEMORY_CRITICAL_PERCENT <=
      value.ANOMALY_MEMORY_WARNING_PERCENT
    )
      context.addIssue({
        code: 'custom',
        path: ['ANOMALY_MEMORY_CRITICAL_PERCENT'],
        message: 'must exceed warning threshold',
      });
    if (value.ANOMALY_CPU_CRITICAL_PERCENT <= value.ANOMALY_CPU_WARNING_PERCENT)
      context.addIssue({
        code: 'custom',
        path: ['ANOMALY_CPU_CRITICAL_PERCENT'],
        message: 'must exceed warning threshold',
      });
  });

export type Environment = z.infer<typeof environmentSchema>;

export interface ApplicationConfig {
  readonly developmentAgentToken?: string;
  readonly application: ApplicationName;
  readonly environment: Environment['NODE_ENV'];
  readonly version: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: Environment['LOG_LEVEL'];
  readonly enabledComponents: readonly string[];
  readonly anomalyThresholds: AnomalyThresholds;
  readonly incidentCorrelation: IncidentCorrelationConfig;
  readonly infrastructure: InfrastructureConfig;
}

export interface InfrastructureConfig {
  databaseUrl?: string;
  redisUrl?: string;
  brokerUrl?: string;
  brokerClientId: string;
  brokerConsumerGroup: string;
  brokerMaxDeliver: number;
  brokerRetryDelayMs: number;
  resourceStateTtlMs: number;
}

export interface AnomalyThresholds {
  memoryWarningPercent: number;
  memoryCriticalPercent: number;
  cpuWarningPercent: number;
  cpuCriticalPercent: number;
  restartThreshold: number;
  notReadyDurationMs: number;
  deploymentDegradationDurationMs: number;
}

export interface IncidentCorrelationConfig {
  correlationWindowMs: number;
  stabilizationPeriodMs: number;
}

export const APPLICATION_CONFIG = Symbol('faultline.application-config');

export function validateEnvironment(
  application: ApplicationName,
  values: Record<string, unknown>,
): Environment {
  const result = environmentSchema.safeParse({
    ...values,
    PORT: values.PORT ?? applicationDefinitions[application].port,
  });
  if (!result.success) {
    // Never echo values: future configuration may contain credentials.
    throw new Error(
      'Invalid environment fields: ' +
        [
          ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
        ].join(', '),
    );
  }
  if (result.data.NODE_ENV !== 'test') {
    const missing = [
      ...((application === 'api' || application === 'processor') &&
      !result.data.DATABASE_URL
        ? ['DATABASE_URL']
        : []),
      ...(application === 'processor' && !result.data.REDIS_URL
        ? ['REDIS_URL']
        : []),
      ...((application === 'ingestion' || application === 'processor') &&
      !result.data.BROKER_URL
        ? ['BROKER_URL']
        : []),
    ];
    if (missing.length)
      throw new Error('Invalid environment fields: ' + missing.join(', '));
  }
  return result.data;
}

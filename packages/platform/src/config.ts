import { z } from 'zod';

export const applicationDefinitions = {
  api: { port: 3000, components: ['configuration', 'logging', 'health', 'system-info'] },
  ingestion: { port: 3001, components: ['configuration', 'logging', 'health'] },
  processor: { port: 3002, components: ['configuration', 'logging', 'health'] },
} as const;

export type ApplicationName = keyof typeof applicationDefinitions;
export const logLevels = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  APP_VERSION: z.string().trim().min(1),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(logLevels).default('log'),
});

export type Environment = z.infer<typeof environmentSchema>;

export interface ApplicationConfig {
  readonly application: ApplicationName;
  readonly environment: Environment['NODE_ENV'];
  readonly version: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: Environment['LOG_LEVEL'];
  readonly enabledComponents: readonly string[];
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
    throw new Error('Invalid environment fields: ' +
      [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', '));
  }
  return result.data;
}

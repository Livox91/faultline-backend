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

/** Undefined stays undefined: the API treats that as the development-only wide scope. */
function parseClusterScope(
  value: string | undefined,
): readonly string[] | undefined {
  if (!value) return undefined;
  const clusters = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (!clusters.length)
    throw new Error('TELEMETRY_QUERY_CLUSTER_SCOPE lists no clusters');
  return Object.freeze(clusters);
}

/**
 * Both halves or neither: a half-configured bootstrap admin is a configuration mistake,
 * not a user with an empty password.
 */
function bootstrapAdmin(
  email: string | undefined,
  password: string | undefined,
): { email: string; password: string } | undefined {
  if (!email && !password) return undefined;
  if (!email || !password)
    throw new Error(
      'AUTH_BOOTSTRAP_ADMIN_EMAIL and AUTH_BOOTSTRAP_ADMIN_PASSWORD must be set together',
    );
  return Object.freeze({ email, password });
}

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
              auth: Object.freeze({
                jwtSecret: config.get('AUTH_JWT_SECRET', { infer: true }),
                issuer: config.get('AUTH_TOKEN_ISSUER', { infer: true }),
                accessTokenTtlSeconds: config.get(
                  'AUTH_ACCESS_TOKEN_TTL_SECONDS',
                  { infer: true },
                ),
                mfaRequired: config.get('AUTH_MFA_REQUIRED', { infer: true }),
                bootstrapAdmin: bootstrapAdmin(
                  config.get('AUTH_BOOTSTRAP_ADMIN_EMAIL', { infer: true }),
                  config.get('AUTH_BOOTSTRAP_ADMIN_PASSWORD', { infer: true }),
                ),
              }),
              publicUrl: config
                .get('APP_PUBLIC_URL', { infer: true })
                .replace(/\/+$/, ''),
              applicationName: config.get('APP_NAME', { infer: true }),
              billing: Object.freeze({
                enabled: config.get('BILLING_ENABLED', { infer: true }),
                provider: 'stripe' as const,
                secretKey: config.get('STRIPE_SECRET_KEY', { infer: true }),
                webhookSecret: config.get('STRIPE_WEBHOOK_SECRET', {
                  infer: true,
                }),
                priceIds: Object.freeze({
                  basic: config.get('STRIPE_PRICE_ID_BASIC', { infer: true }),
                  pro: config.get('STRIPE_PRICE_ID_PRO', { infer: true }),
                  // `enterprise` is priced by conversation and has no price id.
                }),
                salesContact: config.get('BILLING_SALES_CONTACT', {
                  infer: true,
                }),
              }),
              email: Object.freeze({
                transport: config.get('EMAIL_TRANSPORT', { infer: true }),
                from: config.get('EMAIL_FROM', { infer: true }),
                ...(config.get('EMAIL_TRANSPORT', { infer: true }) === 'smtp'
                  ? {
                      smtp: Object.freeze({
                        host: config.get('SMTP_HOST', { infer: true })!,
                        port: config.get('SMTP_PORT', { infer: true }),
                        secure: config.get('SMTP_SECURE', { infer: true }),
                        username: config.get('SMTP_USERNAME', { infer: true }),
                        password: config.get('SMTP_PASSWORD', { infer: true }),
                      }),
                    }
                  : {}),
              }),
              infrastructure: Object.freeze({
                databaseUrl: config.get('DATABASE_URL', { infer: true }),
                redisUrl: config.get('REDIS_URL', { infer: true }),
                brokerUrl: config.get('BROKER_URL', { infer: true }),
                brokerClientId: `${config.get('BROKER_CLIENT_ID', { infer: true })}-${application}`,
                brokerConsumerGroup: config.get('BROKER_CONSUMER_GROUP', {
                  infer: true,
                }),
                brokerMaxDeliver: config.get('BROKER_MAX_DELIVER', {
                  infer: true,
                }),
                brokerRetryDelayMs: config.get('BROKER_RETRY_DELAY_MS', {
                  infer: true,
                }),
                resourceStateTtlMs: config.get('RESOURCE_STATE_TTL_MS', {
                  infer: true,
                }),
                clickhouseUrl: config.get('CLICKHOUSE_URL', { infer: true }),
                clickhouseDatabase: config.get('CLICKHOUSE_DATABASE', {
                  infer: true,
                }),
                clickhouseUsername: config.get('CLICKHOUSE_USERNAME', {
                  infer: true,
                }),
                clickhousePassword: config.get('CLICKHOUSE_PASSWORD', {
                  infer: true,
                }),
                clickhouseRequestTimeoutMs: config.get(
                  'CLICKHOUSE_REQUEST_TIMEOUT_MS',
                  { infer: true },
                ),
              }),
              telemetryStorage: Object.freeze({
                consumerGroup: config.get('TELEMETRY_STORAGE_CONSUMER_GROUP', {
                  infer: true,
                }),
                batchMaxSize: config.get('TELEMETRY_BATCH_MAX_SIZE', {
                  infer: true,
                }),
                batchMaxAgeMs: config.get('TELEMETRY_BATCH_MAX_AGE_MS', {
                  infer: true,
                }),
                retention: Object.freeze({
                  logsDays: config.get('TELEMETRY_RETENTION_LOGS_DAYS', {
                    infer: true,
                  }),
                  metricsDays: config.get('TELEMETRY_RETENTION_METRICS_DAYS', {
                    infer: true,
                  }),
                  kubernetesEventsDays: config.get(
                    'TELEMETRY_RETENTION_KUBERNETES_EVENTS_DAYS',
                    { infer: true },
                  ),
                }),
                payloadLimits: Object.freeze({
                  maxMessageBytes: config.get('TELEMETRY_MAX_MESSAGE_BYTES', {
                    infer: true,
                  }),
                  maxRawPayloadBytes: config.get(
                    'TELEMETRY_MAX_RAW_PAYLOAD_BYTES',
                    { infer: true },
                  ),
                  maxAttributeValueBytes: config.get(
                    'TELEMETRY_MAX_ATTRIBUTE_VALUE_BYTES',
                    { infer: true },
                  ),
                  maxAttributeCount: config.get(
                    'TELEMETRY_MAX_ATTRIBUTE_COUNT',
                    { infer: true },
                  ),
                }),
                queryLimits: Object.freeze({
                  maxTimeRangeMs: config.get('TELEMETRY_QUERY_MAX_RANGE_MS', {
                    infer: true,
                  }),
                  maxMetricTimeRangeMs: config.get(
                    'TELEMETRY_QUERY_MAX_METRIC_RANGE_MS',
                    { infer: true },
                  ),
                  maxLimit: config.get('TELEMETRY_QUERY_MAX_LIMIT', {
                    infer: true,
                  }),
                  defaultLimit: config.get('TELEMETRY_QUERY_DEFAULT_LIMIT', {
                    infer: true,
                  }),
                  queryTimeoutMs: config.get('TELEMETRY_QUERY_TIMEOUT_MS', {
                    infer: true,
                  }),
                  minBucketMs: config.get('TELEMETRY_QUERY_MIN_BUCKET_MS', {
                    infer: true,
                  }),
                  maxBuckets: config.get('TELEMETRY_QUERY_MAX_BUCKETS', {
                    infer: true,
                  }),
                }),
                queryClusterScope: parseClusterScope(
                  config.get('TELEMETRY_QUERY_CLUSTER_SCOPE', { infer: true }),
                ),
              }),
              baselines: Object.freeze({
                windows: Object.freeze({
                  default: config.get('BASELINE_DEFAULT_WINDOW', {
                    infer: true,
                  }),
                  fast: config.get('BASELINE_FAST_WINDOW', { infer: true }),
                }),
                minimumSamples: config.get('BASELINE_MIN_SAMPLES', {
                  infer: true,
                }),
                bucketMs: config.get('BASELINE_BUCKET_MS', { infer: true }),
                refreshIntervalMs: config.get('BASELINE_REFRESH_INTERVAL_MS', {
                  infer: true,
                }),
                maxTargets: config.get('BASELINE_MAX_TARGETS', { infer: true }),
                maxSamplesPerSummary: config.get(
                  'BASELINE_MAX_SAMPLES_PER_SUMMARY',
                  { infer: true },
                ),
                excludeDisruptedPeriods: config.get(
                  'BASELINE_EXCLUDE_DISRUPTED_PERIODS',
                  { infer: true },
                ),
                disruptionPaddingMs: config.get(
                  'BASELINE_DISRUPTION_PADDING_MS',
                  { infer: true },
                ),
                cacheTtlMs: config.get('BASELINE_CACHE_TTL_MS', {
                  infer: true,
                }),
                staleAfterMs: config.get('BASELINE_STALE_AFTER_MS', {
                  infer: true,
                }),
              }),
              statisticalDetection: Object.freeze({
                enabled: config.get('STATISTICAL_DETECTION_ENABLED', {
                  infer: true,
                }),
                evaluationWindowMs: config.get(
                  'STATISTICAL_EVALUATION_WINDOW_MS',
                  { infer: true },
                ),
                minimumCurrentSamples: config.get(
                  'STATISTICAL_MIN_CURRENT_SAMPLES',
                  { infer: true },
                ),
                zScoreThreshold: config.get('STATISTICAL_Z_SCORE_THRESHOLD', {
                  infer: true,
                }),
                zScoreResolveThreshold: config.get(
                  'STATISTICAL_Z_SCORE_RESOLVE_THRESHOLD',
                  { infer: true },
                ),
                percentileRatioThreshold: config.get(
                  'STATISTICAL_PERCENTILE_RATIO_THRESHOLD',
                  { infer: true },
                ),
                percentileRatioResolveThreshold: config.get(
                  'STATISTICAL_PERCENTILE_RATIO_RESOLVE_THRESHOLD',
                  { infer: true },
                ),
                minimumConsecutiveWindows: config.get(
                  'STATISTICAL_MIN_CONSECUTIVE_WINDOWS',
                  { infer: true },
                ),
                resolveConsecutiveWindows: config.get(
                  'STATISTICAL_RESOLVE_CONSECUTIVE_WINDOWS',
                  { infer: true },
                ),
                cooldownMs: config.get('STATISTICAL_COOLDOWN_MS', {
                  infer: true,
                }),
                deviationRelativeFloor: config.get(
                  'STATISTICAL_DEVIATION_RELATIVE_FLOOR',
                  { infer: true },
                ),
                growthMinimumSamples: config.get(
                  'STATISTICAL_GROWTH_MIN_SAMPLES',
                  { infer: true },
                ),
                growthMinimumPercent: config.get(
                  'STATISTICAL_GROWTH_MIN_PERCENT',
                  { infer: true },
                ),
                growthMinimumRSquared: config.get(
                  'STATISTICAL_GROWTH_MIN_R_SQUARED',
                  { infer: true },
                ),
                growthMinimumMonotonicFraction: config.get(
                  'STATISTICAL_GROWTH_MIN_MONOTONIC_FRACTION',
                  { infer: true },
                ),
              }),
              logClassification: Object.freeze({
                enabled: config.get('LOG_CLASSIFIER_ENABLED', { infer: true }),
                minimumConfidence: config.get('LOG_CLASSIFIER_MIN_CONFIDENCE', {
                  infer: true,
                }),
                highConfidence: config.get('LOG_CLASSIFIER_HIGH_CONFIDENCE', {
                  infer: true,
                }),
                mlUrl: config.get('LOG_CLASSIFIER_ML_URL', { infer: true }),
                mlTimeoutMs: config.get('LOG_CLASSIFIER_ML_TIMEOUT_MS', {
                  infer: true,
                }),
                aggregationWindowMs: config.get(
                  'LOG_CLASSIFIER_PATTERN_WINDOW_MS',
                  { infer: true },
                ),
                scoring: Object.freeze({
                  knownClassification: config.get(
                    'LOG_INCIDENT_WEIGHT_KNOWN_CLASSIFICATION',
                    { infer: true },
                  ),
                  errorSeverity: config.get(
                    'LOG_INCIDENT_WEIGHT_ERROR_SEVERITY',
                    { infer: true },
                  ),
                  fatalSeverity: config.get(
                    'LOG_INCIDENT_WEIGHT_FATAL_SEVERITY',
                    { infer: true },
                  ),
                  repeated: config.get('LOG_INCIDENT_WEIGHT_REPEATED', {
                    infer: true,
                  }),
                  frequent: config.get('LOG_INCIDENT_WEIGHT_FREQUENT', {
                    infer: true,
                  }),
                  multiplePods: config.get(
                    'LOG_INCIDENT_WEIGHT_MULTIPLE_PODS',
                    { infer: true },
                  ),
                  repeatedOccurrenceThreshold: config.get(
                    'LOG_INCIDENT_REPEATED_OCCURRENCES',
                    { infer: true },
                  ),
                  frequentOccurrenceThreshold: config.get(
                    'LOG_INCIDENT_FREQUENT_OCCURRENCES',
                    { infer: true },
                  ),
                  anomalyThreshold: config.get(
                    'LOG_INCIDENT_ANOMALY_THRESHOLD',
                    { infer: true },
                  ),
                  incidentThreshold: config.get(
                    'LOG_INCIDENT_INCIDENT_THRESHOLD',
                    { infer: true },
                  ),
                }),
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

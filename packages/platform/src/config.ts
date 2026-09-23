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
      'telemetry-search',
      'baselines',
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
      'statistical-detection',
      'log-classification',
      'incident-correlation',
    ],
  },
  storage: {
    port: 3003,
    components: ['configuration', 'logging', 'health', 'telemetry-storage'],
  },
  notification: {
    port: 3004,
    components: ['configuration', 'logging', 'health', 'notification-policy', 'retell-communication'],
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

/**
 * Historical windows a baseline may cover.
 *
 * Structurally identical to `BaselineWindow` in `@faultline/baselines`. The platform
 * package stays dependency-free on purpose, so the two are kept in step by a
 * compile-time check where both are imported (see the processor's statistical wiring).
 */
export const baselineWindowNames = ['1h', '6h', '24h', '7d'] as const;
export type BaselineWindowName = (typeof baselineWindowNames)[number];
const baselineWindow = z.enum(baselineWindowNames);

/** Environment values are strings; `true`/`false` are the only accepted spellings. */
const booleanFlag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    APP_VERSION: z.string().trim().min(1),
    HOST: z.string().trim().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535),
    LOG_LEVEL: z.enum(logLevels).default('log'),
    FAULTLINE_DEV_AGENT_TOKEN: z.string().min(1).optional(),
    DATABASE_URL: z.string().url().optional(),

    /**
     * Authentication and authorization.
     *
     * The secret signs the access tokens the API issues today. When an enterprise
     * identity provider (SSO/OIDC/LDAP) is put in front, these are replaced by the
     * provider's issuer and JWKS and nothing else in the request path changes.
     */
    AUTH_JWT_SECRET: z.string().min(32).optional(),
    AUTH_TOKEN_ISSUER: z.string().trim().min(1).default('faultline'),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(3600),
    /** When true, a login returns a challenge and the token is issued after the code. */
    AUTH_MFA_REQUIRED: booleanFlag(false),
    /**
     * Public base URL of the web application.
     *
     * Used to build the links a purchaser receives - the checkout return URLs and the
     * sign-in link in the credentials email - which is why it must be the address the
     * customer's browser can reach, not the API's own host.
     */
    APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
    APP_NAME: z.string().trim().min(1).default('Faultline'),

    // --- Billing (Stripe) ---------------------------------------------------
    /** Server-side secret key. Never reaches the browser. */
    STRIPE_SECRET_KEY: z.string().trim().min(1).optional(),
    /**
     * Signing secret for the webhook endpoint.
     *
     * Without it a webhook cannot be verified, and an unverified webhook is simply an
     * anonymous HTTP request asking us to create an Admin account - so the endpoint
     * refuses to operate when this is unset.
     */
    STRIPE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
    /**
     * The Stripe Price the Basic plan is sold at, e.g. `price_1234`.
     *
     * Basic is free, but it is still a recurring price of zero at the provider: that
     * keeps one provisioning path for every self-serve tier instead of an unpaid side
     * door that creates Admin accounts.
     */
    STRIPE_PRICE_ID_BASIC: z.string().trim().min(1).optional(),
    /** The Stripe Price the Pro plan is sold at, e.g. `price_1234`. */
    STRIPE_PRICE_ID_PRO: z.string().trim().min(1).optional(),
    /**
     * Where an Enterprise enquiry goes. Shown on the pricing page as a mailto.
     *
     * Optional: with it unset the Enterprise card simply tells the visitor to talk to
     * their account contact, which is better than a link to an address nobody reads.
     */
    BILLING_SALES_CONTACT: z.string().email().optional(),
    /** Turns the public purchase flow on. Off by default. */
    BILLING_ENABLED: booleanFlag(false),

    // --- Outbound email -----------------------------------------------------
    /** `smtp` sends; `log` records to the application log (development only). */
    EMAIL_TRANSPORT: z.enum(['smtp', 'log']).default('log'),
    EMAIL_FROM: z.string().trim().min(1).default('Faultline <no-reply@faultline.local>'),
    SMTP_HOST: z.string().trim().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanFlag(false),
    SMTP_USERNAME: z.string().trim().min(1).optional(),
    SMTP_PASSWORD: z.string().optional(),

    /** Seeds the first Admin on startup when the users table is empty. */
    AUTH_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
    AUTH_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
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
    CLICKHOUSE_URL: z.string().url().optional(),
    CLICKHOUSE_DATABASE: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .default('faultline'),
    CLICKHOUSE_USERNAME: z.string().trim().min(1).default('default'),
    CLICKHOUSE_PASSWORD: z.string().optional(),
    CLICKHOUSE_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .default(30000),
    TELEMETRY_BATCH_MAX_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(50000)
      .default(500),
    TELEMETRY_BATCH_MAX_AGE_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(300000)
      .default(2000),
    TELEMETRY_RETENTION_LOGS_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(7),
    TELEMETRY_RETENTION_METRICS_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(14),
    TELEMETRY_RETENTION_KUBERNETES_EVENTS_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(30),
    TELEMETRY_MAX_MESSAGE_BYTES: z.coerce
      .number()
      .int()
      .min(256)
      .max(1048576)
      .default(32768),
    TELEMETRY_MAX_RAW_PAYLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(0)
      .max(4194304)
      .default(65536),
    TELEMETRY_MAX_ATTRIBUTE_VALUE_BYTES: z.coerce
      .number()
      .int()
      .min(64)
      .max(262144)
      .default(4096),
    TELEMETRY_MAX_ATTRIBUTE_COUNT: z.coerce
      .number()
      .int()
      .min(1)
      .max(4096)
      .default(128),
    TELEMETRY_QUERY_MAX_RANGE_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(86400000),
    TELEMETRY_QUERY_MAX_METRIC_RANGE_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(604800000),
    TELEMETRY_QUERY_MAX_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(500),
    TELEMETRY_QUERY_DEFAULT_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(100),
    TELEMETRY_QUERY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(120000)
      .default(10000),
    TELEMETRY_QUERY_MIN_BUCKET_MS: z.coerce.number().int().min(1).default(1000),
    TELEMETRY_QUERY_MAX_BUCKETS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(1000),
    /** Comma-separated clusters this deployment may query; required in production. */
    TELEMETRY_QUERY_CLUSTER_SCOPE: z.string().trim().min(1).optional(),
    /**
     * Durable broker consumer for telemetry storage. It must differ from
     * `BROKER_CONSUMER_GROUP`: sharing one group would make storage and the processor
     * split the stream between them instead of each seeing every event.
     */
    TELEMETRY_STORAGE_CONSUMER_GROUP: z
      .string()
      .trim()
      .min(1)
      .default('faultline-telemetry-storage'),

    // Baselines. No universal window is assumed: slow-moving signals such as memory use
    // the default window, while latency and error rates use the shorter fast window.
    BASELINE_DEFAULT_WINDOW: baselineWindow.default('24h'),
    BASELINE_FAST_WINDOW: baselineWindow.default('1h'),
    BASELINE_MIN_SAMPLES: z.coerce
      .number()
      .int()
      .min(2)
      .max(1_000_000)
      .default(60),
    BASELINE_BUCKET_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .default(60_000),
    BASELINE_REFRESH_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(86_400_000)
      .default(900_000),
    BASELINE_MAX_TARGETS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(200),
    BASELINE_MAX_SAMPLES_PER_SUMMARY: z.coerce
      .number()
      .int()
      .min(100)
      .default(2_000_000),
    BASELINE_EXCLUDE_DISRUPTED_PERIODS: booleanFlag(true),
    BASELINE_DISRUPTION_PADDING_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(3_600_000)
      .default(300_000),
    BASELINE_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .default(60_000),
    BASELINE_STALE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(604_800_000),

    // Statistical detection. Every threshold here is a tuning knob, never a hard failure
    // condition: deterministic limits stay in the rule engine's own settings.
    STATISTICAL_DETECTION_ENABLED: booleanFlag(true),
    STATISTICAL_EVALUATION_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(86_400_000)
      .default(900_000),
    STATISTICAL_MIN_CURRENT_SAMPLES: z.coerce
      .number()
      .int()
      .min(2)
      .max(10_000)
      .default(5),
    STATISTICAL_Z_SCORE_THRESHOLD: z.coerce
      .number()
      .min(0.5)
      .max(50)
      .default(3),
    STATISTICAL_Z_SCORE_RESOLVE_THRESHOLD: z.coerce
      .number()
      .min(0.1)
      .max(50)
      .default(2),
    STATISTICAL_PERCENTILE_RATIO_THRESHOLD: z.coerce
      .number()
      .min(1.05)
      .max(100)
      .default(2),
    STATISTICAL_PERCENTILE_RATIO_RESOLVE_THRESHOLD: z.coerce
      .number()
      .min(1)
      .max(100)
      .default(1.5),
    STATISTICAL_MIN_CONSECUTIVE_WINDOWS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(3),
    STATISTICAL_RESOLVE_CONSECUTIVE_WINDOWS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(3),
    STATISTICAL_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(86_400_000)
      .default(600_000),
    STATISTICAL_DEVIATION_RELATIVE_FLOOR: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.05),
    STATISTICAL_GROWTH_MIN_SAMPLES: z.coerce
      .number()
      .int()
      .min(3)
      .max(1000)
      .default(6),
    STATISTICAL_GROWTH_MIN_PERCENT: z.coerce
      .number()
      .min(1)
      .max(10_000)
      .default(25),
    STATISTICAL_GROWTH_MIN_R_SQUARED: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.7),
    STATISTICAL_GROWTH_MIN_MONOTONIC_FRACTION: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.7),

    LOG_CLASSIFIER_ENABLED: booleanFlag(true),
    LOG_CLASSIFIER_ML_URL: z.string().url().optional(),
    LOG_CLASSIFIER_ML_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(120_000)
      .default(2_000),
    LOG_CLASSIFIER_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
    LOG_CLASSIFIER_HIGH_CONFIDENCE: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.85),
    LOG_CLASSIFIER_PATTERN_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(600_000),
    LOG_INCIDENT_WEIGHT_KNOWN_CLASSIFICATION: z.coerce
      .number()
      .min(0)
      .default(3),
    LOG_INCIDENT_WEIGHT_ERROR_SEVERITY: z.coerce.number().min(0).default(1),
    LOG_INCIDENT_WEIGHT_FATAL_SEVERITY: z.coerce.number().min(0).default(2),
    LOG_INCIDENT_WEIGHT_REPEATED: z.coerce.number().min(0).default(2),
    LOG_INCIDENT_WEIGHT_FREQUENT: z.coerce.number().min(0).default(3),
    LOG_INCIDENT_WEIGHT_MULTIPLE_PODS: z.coerce.number().min(0).default(2),
    LOG_INCIDENT_REPEATED_OCCURRENCES: z.coerce
      .number()
      .int()
      .min(2)
      .default(5),
    LOG_INCIDENT_FREQUENT_OCCURRENCES: z.coerce
      .number()
      .int()
      .min(3)
      .default(20),
    LOG_INCIDENT_ANOMALY_THRESHOLD: z.coerce.number().min(1).default(6),
    LOG_INCIDENT_INCIDENT_THRESHOLD: z.coerce.number().min(1).default(9),
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
    if (value.TELEMETRY_STORAGE_CONSUMER_GROUP === value.BROKER_CONSUMER_GROUP)
      context.addIssue({
        code: 'custom',
        path: ['TELEMETRY_STORAGE_CONSUMER_GROUP'],
        message: 'must differ from BROKER_CONSUMER_GROUP',
      });
    // Hysteresis only works when leaving an anomaly is harder than entering one.
    if (
      value.STATISTICAL_Z_SCORE_RESOLVE_THRESHOLD >=
      value.STATISTICAL_Z_SCORE_THRESHOLD
    )
      context.addIssue({
        code: 'custom',
        path: ['STATISTICAL_Z_SCORE_RESOLVE_THRESHOLD'],
        message: 'must be below STATISTICAL_Z_SCORE_THRESHOLD',
      });
    if (
      value.STATISTICAL_PERCENTILE_RATIO_RESOLVE_THRESHOLD >=
      value.STATISTICAL_PERCENTILE_RATIO_THRESHOLD
    )
      context.addIssue({
        code: 'custom',
        path: ['STATISTICAL_PERCENTILE_RATIO_RESOLVE_THRESHOLD'],
        message: 'must be below STATISTICAL_PERCENTILE_RATIO_THRESHOLD',
      });
    if (
      value.LOG_CLASSIFIER_MIN_CONFIDENCE >=
      value.LOG_CLASSIFIER_HIGH_CONFIDENCE
    )
      context.addIssue({
        code: 'custom',
        path: ['LOG_CLASSIFIER_MIN_CONFIDENCE'],
        message: 'must be below LOG_CLASSIFIER_HIGH_CONFIDENCE',
      });
    if (
      value.LOG_INCIDENT_REPEATED_OCCURRENCES >=
      value.LOG_INCIDENT_FREQUENT_OCCURRENCES
    )
      context.addIssue({
        code: 'custom',
        path: ['LOG_INCIDENT_FREQUENT_OCCURRENCES'],
        message: 'must exceed LOG_INCIDENT_REPEATED_OCCURRENCES',
      });
    if (
      value.LOG_INCIDENT_ANOMALY_THRESHOLD >=
      value.LOG_INCIDENT_INCIDENT_THRESHOLD
    )
      context.addIssue({
        code: 'custom',
        path: ['LOG_INCIDENT_INCIDENT_THRESHOLD'],
        message: 'must exceed LOG_INCIDENT_ANOMALY_THRESHOLD',
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
  readonly auth: AuthSettings;
  readonly billing: BillingSettings;
  readonly email: EmailSettings;
  readonly publicUrl: string;
  readonly applicationName: string;
  readonly infrastructure: InfrastructureConfig;
  readonly telemetryStorage: TelemetryStorageConfig;
  readonly baselines: BaselineSettings;
  readonly statisticalDetection: StatisticalDetectionSettings;
  readonly logClassification: LogClassificationSettings;
}

/**
 * How expected behaviour is computed and kept fresh.
 *
 * Windows are configurable per speed rather than universal: a memory baseline wants a
 * day of history, while an error rate that only matters over minutes wants an hour.
 */
export interface BaselineSettings {
  windows: { default: BaselineWindowName; fast: BaselineWindowName };
  /** Below this, a baseline reports BASELINE_NOT_READY instead of a shaky mean. */
  minimumSamples: number;
  bucketMs: number;
  refreshIntervalMs: number;
  maxTargets: number;
  maxSamplesPerSummary: number;
  excludeDisruptedPeriods: boolean;
  disruptionPaddingMs: number;
  cacheTtlMs: number;
  staleAfterMs: number;
}

export interface StatisticalDetectionSettings {
  enabled: boolean;
  evaluationWindowMs: number;
  minimumCurrentSamples: number;
  zScoreThreshold: number;
  zScoreResolveThreshold: number;
  percentileRatioThreshold: number;
  percentileRatioResolveThreshold: number;
  minimumConsecutiveWindows: number;
  resolveConsecutiveWindows: number;
  cooldownMs: number;
  deviationRelativeFloor: number;
  growthMinimumSamples: number;
  growthMinimumPercent: number;
  growthMinimumRSquared: number;
  growthMinimumMonotonicFraction: number;
}

export interface LogClassificationSettings {
  enabled: boolean;
  minimumConfidence: number;
  highConfidence: number;
  mlUrl?: string;
  mlTimeoutMs: number;
  aggregationWindowMs: number;
  scoring: {
    knownClassification: number;
    errorSeverity: number;
    fatalSeverity: number;
    repeated: number;
    frequent: number;
    multiplePods: number;
    repeatedOccurrenceThreshold: number;
    frequentOccurrenceThreshold: number;
    anomalyThreshold: number;
    incidentThreshold: number;
  };
}

/**
 * How a request proves who it is, and how long that proof lasts.
 *
 * `bootstrapAdmin` exists so a fresh deployment is reachable at all: without a first
 * Admin there is nobody who can create one, and every endpoint now refuses anonymous
 * callers. It seeds only when the users table is empty.
 */
export interface AuthSettings {
  readonly jwtSecret?: string;
  readonly issuer: string;
  readonly accessTokenTtlSeconds: number;
  readonly mfaRequired: boolean;
  readonly bootstrapAdmin?: { email: string; password: string };
}

/**
 * The public purchase flow.
 *
 * `enabled` is a real switch, not a formality: with billing off the checkout and
 * webhook routes are not registered at all, so a deployment that does not sell
 * subscriptions has no public account-creating surface to attack.
 */
export interface BillingSettings {
  readonly enabled: boolean;
  readonly provider: 'stripe';
  readonly secretKey?: string;
  readonly webhookSecret?: string;
  readonly priceIds: Readonly<Record<string, string | undefined>>;
  /** Address for tiers that are sold by conversation; absent when none is configured. */
  readonly salesContact?: string;
}

export interface EmailSettings {
  readonly transport: 'smtp' | 'log';
  readonly from: string;
  readonly smtp?: {
    host: string;
    port: number;
    secure: boolean;
    username?: string;
    password?: string;
  };
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
  clickhouseUrl?: string;
  clickhouseDatabase: string;
  clickhouseUsername: string;
  clickhousePassword?: string;
  clickhouseRequestTimeoutMs: number;
}

/**
 * Telemetry-history settings.
 *
 * Batching and payload limits belong to the storage consumer; query limits and the
 * cluster scope belong to the API. Both live here so one validated configuration object
 * describes the whole telemetry-history path.
 */
export interface TelemetryStorageConfig {
  /** Durable broker consumer group; separate from the processor's by construction. */
  consumerGroup: string;
  batchMaxSize: number;
  batchMaxAgeMs: number;
  retention: TelemetryRetentionSettings;
  payloadLimits: TelemetryPayloadLimitSettings;
  queryLimits: TelemetryQueryLimitSettings;
  /** Clusters this deployment may query; undefined means "development, all clusters". */
  queryClusterScope?: readonly string[];
}

export interface TelemetryRetentionSettings {
  logsDays: number;
  metricsDays: number;
  kubernetesEventsDays: number;
}

export interface TelemetryPayloadLimitSettings {
  maxMessageBytes: number;
  maxRawPayloadBytes: number;
  maxAttributeValueBytes: number;
  maxAttributeCount: number;
}

export interface TelemetryQueryLimitSettings {
  maxTimeRangeMs: number;
  maxMetricTimeRangeMs: number;
  maxLimit: number;
  defaultLimit: number;
  queryTimeoutMs: number;
  minBucketMs: number;
  maxBuckets: number;
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
      // The API refuses anonymous requests, so it cannot start without the key it
      // verifies tokens with: starting anyway would mean every request 500s.
      ...(application === 'api' && !result.data.AUTH_JWT_SECRET
        ? ['AUTH_JWT_SECRET']
        : []),
      ...((application === 'api' ||
        application === 'processor' ||
        application === 'notification') &&
      !result.data.DATABASE_URL
        ? ['DATABASE_URL']
        : []),
      ...(application === 'processor' && !result.data.REDIS_URL
        ? ['REDIS_URL']
        : []),
      ...((application === 'ingestion' ||
        application === 'processor' ||
        application === 'storage' ||
        application === 'notification') &&
      !result.data.BROKER_URL
        ? ['BROKER_URL']
        : []),
      // The processor deliberately never needs ClickHouse: detection must keep
      // running while telemetry history is unavailable, comparing live telemetry
      // against the baselines already written to PostgreSQL.
      ...((application === 'api' || application === 'storage') &&
      !result.data.CLICKHOUSE_URL
        ? ['CLICKHOUSE_URL']
        : []),
      // Storage derives baselines from telemetry history and writes them to PostgreSQL,
      // reading incident windows from there to keep outages out of the baseline.
      ...(application === 'storage' && !result.data.DATABASE_URL
        ? ['DATABASE_URL']
        : []),
      ...(application === 'api' &&
      result.data.NODE_ENV === 'production' &&
      !result.data.TELEMETRY_QUERY_CLUSTER_SCOPE
        ? ['TELEMETRY_QUERY_CLUSTER_SCOPE']
        : []),
      // Half-configured billing is worse than none: checkout would succeed and the
      // webhook that provisions the account would be unverifiable.
      ...(application === 'api' && result.data.BILLING_ENABLED
        ? [
            ...(result.data.STRIPE_SECRET_KEY ? [] : ['STRIPE_SECRET_KEY']),
            ...(result.data.STRIPE_WEBHOOK_SECRET
              ? []
              : ['STRIPE_WEBHOOK_SECRET']),
            // Only the paid tier is required to boot. A tier with no configured price
            // cannot be bought, which the pricing page says on its card - unlike a
            // missing secret, it degrades one card rather than the whole flow.
            ...(result.data.STRIPE_PRICE_ID_PRO ? [] : ['STRIPE_PRICE_ID_PRO']),
          ]
        : []),
      // Credentials are emailed. A production deployment that only logs them would
      // strand every purchaser, so the log transport is refused there.
      ...(application === 'api' &&
      result.data.NODE_ENV === 'production' &&
      result.data.BILLING_ENABLED &&
      result.data.EMAIL_TRANSPORT !== 'smtp'
        ? ['EMAIL_TRANSPORT']
        : []),
      ...(application === 'api' && result.data.EMAIL_TRANSPORT === 'smtp'
        ? [...(result.data.SMTP_HOST ? [] : ['SMTP_HOST'])]
        : []),
    ];
    if (missing.length)
      throw new Error('Invalid environment fields: ' + missing.join(', '));
  }
  return result.data;
}

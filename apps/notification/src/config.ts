import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export interface SlackWorkerConfig {
  enabled: boolean;
  botToken?: string;
  incidentChannelId?: string;
  dashboardUrl?: string;
  serviceChannels: Readonly<Record<string, string>>;
  serviceOwners: Readonly<Record<string, string>>;
  teamChannels: Readonly<Record<string, string>>;
}

export interface NotificationWorkerConfig {
  slackTokenEncryptionKey?: string;
  apiKey?: string;
  fromNumber?: string;
  voiceAgentId?: string;
  smsAgentId?: string;
  highSeverityEnabled: boolean;
  consumerGroup: string;
  organizationId: string;
  schedulerPollMs: number;
  schedulerLeaseMs: number;
  staleAttemptMs: number;
  attemptRetentionDays: number;
  auditRetentionDays: number;
  slack: SlackWorkerConfig;
}

const unset = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return !trimmed || /^<.*>$/.test(trimmed) ? undefined : trimmed;
};

const optionalText = z.preprocess(unset, z.string().trim().min(1).optional());
const optionalPhone = z.preprocess(
  unset,
  z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .optional(),
);

const notificationEnvironment = z
  .object({
    RETELL_API_KEY: optionalText,
    RETELL_FROM_NUMBER: optionalPhone,
    RETELL_VOICE_AGENT_ID: optionalText,
    RETELL_SMS_AGENT_ID: optionalText,
    NOTIFICATION_HIGH_SEVERITY_ENABLED: z
      .enum(['true', 'false'])
      .default('false'),
    NOTIFICATION_CONSUMER_GROUP: z
      .string()
      .min(1)
      .default('faultline-notifications'),
    NOTIFICATION_ORGANIZATION_ID: z.string().min(1).default('default'),
    NOTIFICATION_SCHEDULER_POLL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .default(5000),
    NOTIFICATION_SCHEDULER_LEASE_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(30000),
    NOTIFICATION_STALE_ATTEMPT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(300000),
    NOTIFICATION_ATTEMPT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .default(90),
    NOTIFICATION_AUDIT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .default(365),
    SLACK_ENABLED: z.enum(['true', 'false']).default('false'),
    SLACK_TOKEN_ENCRYPTION_KEY: optionalText,
    SLACK_BOT_TOKEN: optionalText,
    SLACK_INCIDENT_CHANNEL_ID: optionalText,
    SLACK_DASHBOARD_URL: z.preprocess(unset, z.string().url().optional()),
    SLACK_SERVICE_CHANNELS: optionalText,
    SLACK_SERVICE_OWNERS: optionalText,
    SLACK_TEAM_CHANNELS: optionalText,
  })
  .superRefine((value, context) => {
    const retellValues = [
      value.RETELL_API_KEY,
      value.RETELL_FROM_NUMBER,
      value.RETELL_VOICE_AGENT_ID,
    ];
    const retellRequested =
      retellValues.some(Boolean) || Boolean(value.RETELL_SMS_AGENT_ID);
    if (!retellRequested) return;
    const names = [
      'RETELL_API_KEY',
      'RETELL_FROM_NUMBER',
      'RETELL_VOICE_AGENT_ID',
    ] as const;
    for (let index = 0; index < retellValues.length; index++)
      if (!retellValues[index])
        context.addIssue({
          code: 'custom',
          path: [names[index]!],
          message: 'is required when Retell is configured',
        });
  });

/**
 * Standalone applications do not receive notification-specific values through the
 * shared PlatformModule config object. Read the service's private env file here, while
 * still allowing real process variables to override it in containers and production.
 */
function defaultEnvironment(): NodeJS.ProcessEnv {
  const path = resolve(__dirname, '../.env');
  const fromFile: Record<string, string> = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      fromFile[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
    }
  }
  return { ...fromFile, ...process.env };
}

export function loadNotificationConfig(
  env: NodeJS.ProcessEnv = defaultEnvironment(),
): NotificationWorkerConfig {
  const value = notificationEnvironment.parse(env);
  const slackEnabled =
    value.SLACK_ENABLED === 'true' &&
    !!value.SLACK_BOT_TOKEN &&
    !!value.SLACK_INCIDENT_CHANNEL_ID;
  return {
    slackTokenEncryptionKey: value.SLACK_TOKEN_ENCRYPTION_KEY,
    apiKey: value.RETELL_API_KEY,
    fromNumber: value.RETELL_FROM_NUMBER,
    voiceAgentId: value.RETELL_VOICE_AGENT_ID,
    smsAgentId: value.RETELL_SMS_AGENT_ID,
    highSeverityEnabled:
      value.NOTIFICATION_HIGH_SEVERITY_ENABLED === 'true',
    consumerGroup: value.NOTIFICATION_CONSUMER_GROUP,
    organizationId: value.NOTIFICATION_ORGANIZATION_ID,
    schedulerPollMs: value.NOTIFICATION_SCHEDULER_POLL_MS,
    schedulerLeaseMs: value.NOTIFICATION_SCHEDULER_LEASE_MS,
    staleAttemptMs: value.NOTIFICATION_STALE_ATTEMPT_MS,
    attemptRetentionDays: value.NOTIFICATION_ATTEMPT_RETENTION_DAYS,
    auditRetentionDays: value.NOTIFICATION_AUDIT_RETENTION_DAYS,
    slack: {
      enabled: slackEnabled,
      botToken: value.SLACK_BOT_TOKEN,
      incidentChannelId: value.SLACK_INCIDENT_CHANNEL_ID,
      dashboardUrl: value.SLACK_DASHBOARD_URL,
      serviceChannels: parseMapping(value.SLACK_SERVICE_CHANNELS),
      serviceOwners: parseMapping(value.SLACK_SERVICE_OWNERS),
      teamChannels: parseMapping(value.SLACK_TEAM_CHANNELS),
    },
  };
}

function parseMapping(
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
      return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, item]) =>
        typeof item === 'string' && key.trim() && item.trim()
          ? [[key.trim().toLowerCase(), item.trim()]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export const NOTIFICATION_CONFIG = Symbol('faultline.notification-config');

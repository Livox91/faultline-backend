import type {
  SlackIntegration,
  SlackIntegrationChanges,
  SlackIntegrationRepository,
} from '@faultline/notifications';
import type { PostgresConnection } from './index';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

interface SlackIntegrationRow {
  organization_id: string;
  slack_enabled: boolean;
  slack_bot_token: string | null;
  slack_incident_channel_id: string | null;
  slack_service_channels: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

const columns = `organization_id, slack_enabled, slack_bot_token,
  slack_incident_channel_id, slack_service_channels, created_at, updated_at`;

const present = (row: SlackIntegrationRow): SlackIntegration => ({
  organizationId: row.organization_id,
  enabled: row.slack_enabled,
  ...(row.slack_bot_token ? { botToken: row.slack_bot_token } : {}),
  ...(row.slack_incident_channel_id
    ? { incidentChannelId: row.slack_incident_channel_id }
    : {}),
  serviceChannels: row.slack_service_channels ?? {},
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class PostgresSlackIntegrationRepository
  implements SlackIntegrationRepository
{
  constructor(
    private readonly db: PostgresConnection,
    private readonly encryptionKey?: string,
  ) {}

  async get(organizationId: string): Promise<SlackIntegration | undefined> {
    const result = await this.db.pool.query<SlackIntegrationRow>(
      `SELECT ${columns} FROM slack_integrations WHERE organization_id=$1`,
      [organizationId],
    );
    return result.rows[0] ? this.present(result.rows[0]) : undefined;
  }

  async findForIncident(incidentId: string): Promise<SlackIntegration | undefined> {
    const result = await this.db.pool.query<SlackIntegrationRow>(
      `SELECT s.organization_id, s.slack_enabled, s.slack_bot_token,
              s.slack_incident_channel_id, s.slack_service_channels,
              s.created_at, s.updated_at
         FROM incidents i
         JOIN clusters c ON c.id=i.cluster_id
         JOIN slack_integrations s ON s.organization_id=c.organization_id
        WHERE i.id=$1`,
      [incidentId],
    );
    return result.rows[0] ? this.present(result.rows[0]) : undefined;
  }

  async upsert(organizationId: string, changes: SlackIntegrationChanges) {
    await this.db.pool.query(
      `INSERT INTO slack_integrations
         (organization_id, slack_enabled, slack_bot_token,
          slack_incident_channel_id, slack_service_channels)
       VALUES ($1, COALESCE($2, false), $3, $4, COALESCE($5, '{}'::jsonb))
       ON CONFLICT (organization_id) DO UPDATE SET
         slack_enabled=COALESCE($2, slack_integrations.slack_enabled),
         slack_bot_token=CASE WHEN $6 THEN $3 ELSE slack_integrations.slack_bot_token END,
         slack_incident_channel_id=CASE WHEN $7 THEN $4 ELSE slack_integrations.slack_incident_channel_id END,
         slack_service_channels=COALESCE($5, slack_integrations.slack_service_channels),
         updated_at=now()`,
      [
        organizationId,
        changes.enabled ?? null,
        changes.botToken === undefined || changes.botToken === null
          ? null
          : encrypt(changes.botToken, this.requiredKey()),
        changes.incidentChannelId === undefined ? null : changes.incidentChannelId,
        changes.serviceChannels === undefined
          ? null
          : JSON.stringify(changes.serviceChannels),
        changes.botToken !== undefined,
        changes.incidentChannelId !== undefined,
      ],
    );
    return (await this.get(organizationId))!;
  }

  private present(row: SlackIntegrationRow): SlackIntegration {
    return present({
      ...row,
      slack_bot_token: row.slack_bot_token
        ? decrypt(row.slack_bot_token, this.requiredKey())
        : null,
    });
  }

  private requiredKey(): string {
    if (!this.encryptionKey || this.encryptionKey.length < 32)
      throw new Error('SLACK_TOKEN_ENCRYPTION_KEY must contain at least 32 characters');
    return this.encryptionKey;
  }
}

function key(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
function encrypt(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}
function decrypt(value: string, secret: string): string {
  const [prefix, version, iv, tag, encrypted] = value.split(':');
  if (prefix !== 'enc' || version !== 'v1' || !iv || !tag || !encrypted)
    throw new Error('Stored Slack token is not encrypted');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

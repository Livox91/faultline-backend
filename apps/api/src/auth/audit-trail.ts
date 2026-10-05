import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  AUDIT_LOG_REPOSITORY,
  type AuditAction,
  type AuditLogRepository,
  type AuditOutcome,
  type AuthenticatedUser,
} from '@faultline/auth';
import { clientAddress, userAgent, type RequestWithUser } from './context';

/**
 * Writes the audit trail.
 *
 * Every failure is logged. Deployments with `AUDIT_STRICT=true` also receive the error,
 * making an unavailable integrity trail fail the request; other deployments retain the
 * previous availability-first behavior.
 */
@Injectable()
export class AuditTrail {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly repository: AuditLogRepository,
    private readonly logger: ApplicationLogger,
    @Optional() @Inject(APPLICATION_CONFIG) config?: ApplicationConfig,
  ) {
    this.strict = config?.audit?.strict ?? false;
  }

  private readonly strict: boolean;

  async record(entry: {
    user?: AuthenticatedUser | null;
    actor?: string;
    userId?: string | null;
    action: AuditAction | string;
    resourceType: string;
    resourceId?: string | null;
    outcome?: AuditOutcome;
    request?: RequestWithUser;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.repository.record({
        userId: entry.user?.id ?? entry.userId ?? null,
        actor: entry.user?.email ?? entry.actor ?? 'anonymous',
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        outcome: entry.outcome ?? 'allowed',
        ip: entry.request ? clientAddress(entry.request) : null,
        userAgent: entry.request ? userAgent(entry.request) : null,
        metadata: entry.metadata ?? {},
      });
    } catch (error) {
      this.logger.error({
        event: 'audit_write_failed',
        action: entry.action,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      if (this.strict) throw error;
    }
  }
}

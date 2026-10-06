import { Inject, Injectable } from '@nestjs/common';
import { ApplicationLogger } from '@faultline/platform';
import {
  AUDIT_LOG_REPOSITORY,
  type AuditAction,
  type AuditLogRepository,
  type AuditOutcome,
  type AuthenticatedUser,
} from '@faultline/auth';
import { clientAddress, userAgent, type RequestWithUser } from './context';

/** Writes the audit trail. A failed write fails the request so actions are never
 * reported as allowed without their required audit evidence. */
@Injectable()
export class AuditTrail {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly repository: AuditLogRepository,
    private readonly logger: ApplicationLogger,
  ) {}

  async record(entry: {
    user?: AuthenticatedUser | null;
    actor?: string;
    userId?: string | null;
    organizationId?: string | null;
    action: AuditAction | string;
    resourceType: string;
    resourceId?: string | null;
    outcome?: AuditOutcome;
    request?: RequestWithUser;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.repository.record({
        organizationId:
          entry.user?.organizationId ?? entry.organizationId ?? null,
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
      throw error;
    }
  }
}

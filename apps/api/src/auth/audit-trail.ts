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

/**
 * Writes the audit trail.
 *
 * Recording never fails the operation it describes: an audit write that throws would
 * turn a successful login into a 500 and, worse, would make the trail a denial-of-
 * service surface. A failure is logged at error level instead, where alerting can see
 * it. The trade is deliberate and worth stating: this favours availability of the
 * system over guaranteed completeness of the trail. Deployments that need the opposite
 * should make `record` rethrow.
 */
@Injectable()
export class AuditTrail {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY) private readonly repository: AuditLogRepository,
    private readonly logger: ApplicationLogger,
  ) {}

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
    }
  }
}

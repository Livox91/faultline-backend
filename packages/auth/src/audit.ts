/**
 * The audit vocabulary.
 *
 * Actions are named constants rather than free strings so that a query for "every
 * permission change" cannot miss rows written by a caller that spelled it differently.
 */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  MFA_CHALLENGE_FAILED: 'auth.mfa.challenge.failed',
  MFA_ENROLLMENT_STARTED: 'auth.mfa.enrollment.started',
  MFA_ENABLED: 'auth.mfa.enabled',
  MFA_DISABLED: 'auth.mfa.disabled',
  MFA_RECOVERY_CODES_REGENERATED: 'auth.mfa.recovery-codes.regenerated',
  PASSWORD_RESET_REQUESTED: 'auth.password-reset.requested',
  PASSWORD_RESET_COMPLETED: 'auth.password-reset.completed',
  PASSWORD_RESET_FAILED: 'auth.password-reset.failed',
  SESSIONS_REVOKED: 'auth.sessions.revoked',
  USER_ACTIVITY: 'user.activity',
  PROJECT_CREATED: 'project.created',
  PROJECT_MODIFIED: 'project.modified',
  PROJECT_DELETED: 'project.deleted',
  PROJECT_ASSIGNED: 'project.assignment.created',
  PROJECT_ASSIGNMENT_REMOVED: 'project.assignment.removed',
  CLUSTER_SRE_ASSIGNED: 'cluster.sre.assigned',
  CLUSTER_SRE_REMOVED: 'cluster.sre.removed',
  USER_CREATED: 'user.created',
  PASSWORD_CHANGED: 'user.password.changed',
  USER_STATUS_CHANGED: 'user.status.changed',
  USER_MFA_RESET: 'user.mfa.reset',
  SUBSCRIPTION_PURCHASED: 'subscription.purchased',
  SUBSCRIPTION_PROVISIONED: 'subscription.provisioned',
  SUBSCRIPTION_PROVISIONING_FAILED: 'subscription.provisioning.failed',
  USER_MODIFIED: 'user.modified',
  PERMISSION_CHANGED: 'user.role.changed',
  REMEDIATION_APPROVED: 'remediation.approved',
  REMEDIATION_OVERRIDDEN: 'remediation.overridden',
  REMEDIATION_EXECUTED: 'remediation.executed',
  ACCESS_DENIED: 'access.denied',
  REPORT_EXPORTED: 'report.exported',
  INCIDENT_ACKNOWLEDGED: 'incident.acknowledged',
  CONTACT_CREATED: 'contact.created',
  CONTACT_UPDATED: 'contact.updated',
  NOTIFICATION_GROUP_CREATED: 'notification.group.created',
  ESCALATION_POLICY_CREATED: 'notification.policy.created',
  ESCALATION_POLICY_UPDATED: 'notification.policy.updated',
  ON_CALL_SCHEDULE_CREATED: 'notification.on-call.schedule.created',
  ON_CALL_SCHEDULE_UPDATED: 'notification.on-call.schedule.updated',
  ON_CALL_SHIFT_CREATED: 'notification.on-call.shift.created',
  AVAILABILITY_OVERRIDE_CREATED: 'notification.on-call.override.created',
  SLACK_CONFIGURATION_CHANGED: 'integration.slack.changed',
  SLACK_TICKET_REQUESTED: 'integration.slack.ticket.requested',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditOutcome = 'allowed' | 'denied';

export interface AuditRecord {
  readonly id: string;
  /** Null only when no organization can be identified, such as an unknown login. */
  readonly organizationId: string | null;
  /** Null when the actor could not be identified, as on a failed login. */
  readonly userId: string | null;
  /** Kept alongside the id so a deleted user's trail stays readable. */
  readonly actor: string;
  readonly action: AuditAction | string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: AuditOutcome;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  /** Absent only on records written before integrity protection was enabled. */
  readonly integrity?: AuditRecordIntegrity;
}

export interface AuditRecordIntegrity {
  readonly algorithm: 'hmac-sha256-chain-v1';
  readonly keyId: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly hash: string;
}

export interface AuditIntegrityReport {
  readonly valid: boolean;
  readonly checkedRecords: number;
  readonly unsignedRecords: number;
  readonly headHash: string | null;
  readonly firstInvalidRecordId?: string;
}

export type AuditEntry = Omit<AuditRecord, 'id' | 'occurredAt' | 'integrity'> &
  Partial<Pick<AuditRecord, 'id' | 'occurredAt'>>;

export interface AuditFilter {
  readonly organizationId?: string;
  readonly userId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome?: AuditOutcome;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

/**
 * Append-only by contract as well as by schema.
 *
 * There is no update or delete here, and the migration revokes both at the table, so
 * neither a bug nor a role with write access can quietly rewrite history.
 */
export interface AuditLogRepository {
  record(entry: AuditEntry): Promise<AuditRecord>;
  list(filter?: AuditFilter): Promise<readonly AuditRecord[]>;
  verifyIntegrity(): Promise<AuditIntegrityReport>;
}

export const AUDIT_LOG_REPOSITORY = Symbol('faultline.audit-log-repository');

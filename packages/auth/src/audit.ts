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
  PROJECT_CREATED: 'project.created',
  PROJECT_MODIFIED: 'project.modified',
  PROJECT_DELETED: 'project.deleted',
  PROJECT_ASSIGNED: 'project.assignment.created',
  PROJECT_ASSIGNMENT_REMOVED: 'project.assignment.removed',
  USER_CREATED: 'user.created',
  USER_MODIFIED: 'user.modified',
  PERMISSION_CHANGED: 'user.role.changed',
  REMEDIATION_APPROVED: 'remediation.approved',
  REMEDIATION_OVERRIDDEN: 'remediation.overridden',
  REMEDIATION_EXECUTED: 'remediation.executed',
  ACCESS_DENIED: 'access.denied',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditOutcome = 'allowed' | 'denied';

export interface AuditRecord {
  readonly id: string;
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
}

export type AuditEntry = Omit<AuditRecord, 'id' | 'occurredAt'> &
  Partial<Pick<AuditRecord, 'id' | 'occurredAt'>>;

export interface AuditFilter {
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
}

export const AUDIT_LOG_REPOSITORY = Symbol('faultline.audit-log-repository');

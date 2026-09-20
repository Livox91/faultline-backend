import { randomUUID } from 'node:crypto';
import {
  DuplicateEmailError,
  hashPassword,
  type AuditEntry,
  type AuditFilter,
  type AuditLogRepository,
  type AuditRecord,
  type NewUser,
  type ProjectAssignment,
  type ProjectAssignmentRepository,
  type Role,
  type UserChanges,
  type UserRecord,
  type UserRepository,
  type UserStatus,
} from '@faultline/auth';
import type { PostgresConnection } from './index';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  password_hash: string | null;
  external_subject: string | null;
  status: string;
  mfa_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role as Role,
  status: row.status as UserStatus,
  mfaEnabled: row.mfa_enabled,
  passwordHash: row.password_hash,
  externalSubject: row.external_subject,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const columns = `id, email, name, role, password_hash, external_subject, status, mfa_enabled, created_at, updated_at`;

/** Raised distinctly so the API can answer 409 rather than 500. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: string }).code === '23505';

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly connection: PostgresConnection) {}

  async findById(id: string): Promise<UserRecord | undefined> {
    // Guarded because the id arrives from a token subject or a path parameter, and
    // PostgreSQL raises 22P02 rather than returning nothing for a non-uuid value.
    if (!isUuid(id)) return undefined;
    const result = await this.connection.pool.query<UserRow>(
      `SELECT ${columns} FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const result = await this.connection.pool.query<UserRow>(
      `SELECT ${columns} FROM users WHERE lower(email) = lower($1)`,
      [email.trim()],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }

  async findByExternalSubject(
    subject: string,
  ): Promise<UserRecord | undefined> {
    const result = await this.connection.pool.query<UserRow>(
      `SELECT ${columns} FROM users WHERE external_subject = $1`,
      [subject],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }

  async list(): Promise<readonly UserRecord[]> {
    const result = await this.connection.pool.query<UserRow>(
      `SELECT ${columns} FROM users ORDER BY role, lower(email)`,
    );
    return result.rows.map(toUser);
  }

  async create(user: NewUser): Promise<UserRecord> {
    const passwordHash = user.password
      ? await hashPassword(user.password)
      : null;
    try {
      const result = await this.connection.pool.query<UserRow>(
        `INSERT INTO users (id, email, name, role, password_hash, external_subject, status, mfa_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${columns}`,
        [
          randomUUID(),
          user.email.trim().toLowerCase(),
          user.name.trim(),
          user.role,
          passwordHash,
          user.externalSubject ?? null,
          user.status ?? 'active',
          user.mfaEnabled ?? false,
        ],
      );
      return toUser(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateEmailError();
      throw error;
    }
  }

  /**
   * Partial update.
   *
   * Every column is written from COALESCE against its own parameter so that an omitted
   * field keeps its stored value; passing the whole record back would let a stale read
   * silently revert a concurrent change to a field the caller never touched.
   */
  async update(
    id: string,
    changes: UserChanges,
  ): Promise<UserRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const passwordHash =
      changes.password !== undefined
        ? await hashPassword(changes.password)
        : null;
    const result = await this.connection.pool.query<UserRow>(
      `UPDATE users SET
         name = COALESCE($2, name),
         role = COALESCE($3, role),
         status = COALESCE($4, status),
         mfa_enabled = COALESCE($5, mfa_enabled),
         password_hash = COALESCE($6, password_hash),
         updated_at = now()
       WHERE id = $1
       RETURNING ${columns}`,
      [
        id,
        changes.name ?? null,
        changes.role ?? null,
        changes.status ?? null,
        changes.mfaEnabled ?? null,
        passwordHash,
      ],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }
}

interface AssignmentRow {
  user_id: string;
  project_id: string;
  environments: string[];
  assigned_by: string | null;
  assigned_at: Date;
}

const toAssignment = (row: AssignmentRow): ProjectAssignment => ({
  projectId: row.project_id,
  assignedAt: row.assigned_at.toISOString(),
  ...(row.assigned_by ? { assignedBy: row.assigned_by } : {}),
  ...(row.environments?.length ? { environments: row.environments } : {}),
});

export class PostgresProjectAssignmentRepository
  implements ProjectAssignmentRepository
{
  constructor(private readonly connection: PostgresConnection) {}

  async listForUser(userId: string): Promise<readonly ProjectAssignment[]> {
    if (!isUuid(userId)) return [];
    const result = await this.connection.pool.query<AssignmentRow>(
      `SELECT user_id, project_id, environments, assigned_by, assigned_at
         FROM project_users WHERE user_id = $1 ORDER BY project_id`,
      [userId],
    );
    return result.rows.map(toAssignment);
  }

  /** One round trip for the whole user list, so the admin table is not N+1. */
  async listForUsers(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ProjectAssignment[]>> {
    const ids = userIds.filter(isUuid);
    const grouped = new Map<string, ProjectAssignment[]>(
      ids.map((id) => [id, []]),
    );
    if (!ids.length) return grouped;
    const result = await this.connection.pool.query<AssignmentRow>(
      `SELECT user_id, project_id, environments, assigned_by, assigned_at
         FROM project_users WHERE user_id = ANY($1::uuid[]) ORDER BY project_id`,
      [ids],
    );
    for (const row of result.rows)
      grouped.get(row.user_id)?.push(toAssignment(row));
    return grouped;
  }

  async listUserIdsForProject(projectId: string): Promise<readonly string[]> {
    const result = await this.connection.pool.query<{ user_id: string }>(
      `SELECT user_id FROM project_users WHERE project_id = $1`,
      [projectId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async assign(
    userId: string,
    projectId: string,
    assignedBy: string,
    environments: readonly string[] = [],
  ): Promise<ProjectAssignment> {
    const result = await this.connection.pool.query<AssignmentRow>(
      `INSERT INTO project_users (user_id, project_id, environments, assigned_by)
       VALUES ($1, $2, $3::text[], $4)
       ON CONFLICT (user_id, project_id) DO UPDATE SET
         environments = EXCLUDED.environments,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = now()
       RETURNING user_id, project_id, environments, assigned_by, assigned_at`,
      [userId, projectId, [...environments], isUuid(assignedBy) ? assignedBy : null],
    );
    return toAssignment(result.rows[0]!);
  }

  async remove(userId: string, projectId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const result = await this.connection.pool.query(
      `DELETE FROM project_users WHERE user_id = $1 AND project_id = $2`,
      [userId, projectId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

interface AuditRow {
  id: string;
  user_id: string | null;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

const toAudit = (row: AuditRow): AuditRecord => ({
  id: row.id,
  userId: row.user_id,
  actor: row.actor,
  action: row.action,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  outcome: row.outcome as AuditRecord['outcome'],
  ip: row.ip,
  userAgent: row.user_agent,
  metadata: row.metadata ?? {},
  occurredAt: row.occurred_at.toISOString(),
});

/**
 * Append-only audit storage.
 *
 * There is no update or delete method, and the table refuses both anyway (see
 * migration 0005), so the absence here is a statement rather than an omission.
 */
export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly connection: PostgresConnection) {}

  async record(entry: AuditEntry): Promise<AuditRecord> {
    const result = await this.connection.pool.query<AuditRow>(
      `INSERT INTO audit_log
         (id, user_id, actor, action, resource_type, resource_id, outcome, ip, user_agent, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, COALESCE($11::timestamptz, now()))
       RETURNING id, user_id, actor, action, resource_type, resource_id, outcome, ip, user_agent, metadata, occurred_at`,
      [
        entry.id ?? randomUUID(),
        entry.userId && isUuid(entry.userId) ? entry.userId : null,
        entry.actor,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.outcome,
        entry.ip,
        entry.userAgent,
        JSON.stringify(entry.metadata ?? {}),
        entry.occurredAt ?? null,
      ],
    );
    return toAudit(result.rows[0]!);
  }

  async list(filter: AuditFilter = {}): Promise<readonly AuditRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const where = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace('?', `$${values.length}`));
    };
    if (filter.userId && isUuid(filter.userId)) where('user_id = ?', filter.userId);
    if (filter.action) where('action = ?', filter.action);
    if (filter.resourceType) where('resource_type = ?', filter.resourceType);
    if (filter.resourceId) where('resource_id = ?', filter.resourceId);
    if (filter.outcome) where('outcome = ?', filter.outcome);
    if (filter.since) where('occurred_at >= ?::timestamptz', filter.since);
    if (filter.until) where('occurred_at <= ?::timestamptz', filter.until);
    values.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const result = await this.connection.pool.query<AuditRow>(
      `SELECT id, user_id, actor, action, resource_type, resource_id, outcome, ip, user_agent, metadata, occurred_at
         FROM audit_log
         ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
         ORDER BY occurred_at DESC
         LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toAudit);
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values reaching these adapters come from tokens and URLs; a non-uuid is a miss. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

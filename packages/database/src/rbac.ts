import { randomUUID } from 'node:crypto';
import {
  DuplicateEmailError,
  DuplicateUsernameError,
  PasswordReuseError,
  AUDIT_INTEGRITY_ALGORITHM,
  auditHashesEqual,
  computeAuditHash,
  hashPassword,
  verifyPassword,
  type AuditEntry,
  type AuditFilter,
  type AuditLogRepository,
  type AuditRecord,
  type AuditIntegrityReport,
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
  organization_id: string;
  email: string;
  username: string | null;
  name: string;
  role: string;
  password_hash: string | null;
  external_subject: string | null;
  status: string;
  mfa_enabled: boolean;
  mfa_secret_ciphertext: string | null;
  mfa_recovery_code_hashes: string[];
  mfa_last_used_counter: string | number | null;
  session_version: number;
  must_change_password: boolean;
  created_at: Date;
  updated_at: Date;
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  email: row.email,
  username: row.username,
  name: row.name,
  role: row.role as Role,
  status: row.status as UserStatus,
  mfaEnabled: row.mfa_enabled,
  mfaSecretCiphertext: row.mfa_secret_ciphertext,
  mfaRecoveryCodeHashes: row.mfa_recovery_code_hashes,
  mfaLastUsedCounter:
    row.mfa_last_used_counter === null ? null : Number(row.mfa_last_used_counter),
  sessionVersion: row.session_version,
  mustChangePassword: row.must_change_password,
  passwordHash: row.password_hash,
  externalSubject: row.external_subject,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const columns = `id, organization_id, email, username, name, role, password_hash, external_subject, status, mfa_enabled, mfa_secret_ciphertext, mfa_recovery_code_hashes, mfa_last_used_counter, session_version, must_change_password, created_at, updated_at`;

/** Raised distinctly so the API can answer 409 rather than 500. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: string }).code === '23505';

/** Which unique index was violated, so the caller can say what to change. */
const uniqueViolationOn = (error: unknown, constraint: string): boolean =>
  (error as { constraint?: string })?.constraint === constraint;

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

  async findByIdInOrganization(
    id: string,
    organizationId: string,
  ): Promise<UserRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const result = await this.connection.pool.query<UserRow>(
      `SELECT ${columns} FROM users WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
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

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    const result = await this.connection.pool.query<UserRow>(
      `SELECT ${columns} FROM users WHERE lower(username) = lower($1)`,
      [username.trim()],
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

  async listByOrganization(
    organizationId: string,
  ): Promise<readonly UserRecord[]> {
    const result = await this.connection.pool.query<UserRow>(
      `SELECT ${columns}
         FROM users
        WHERE organization_id = $1
        ORDER BY role, lower(email)`,
      [organizationId],
    );
    return result.rows.map(toUser);
  }

  async create(user: NewUser): Promise<UserRecord> {
    const passwordHash = user.password
      ? await hashPassword(user.password)
      : null;
    try {
      const organizationId = user.organizationId ?? 'default';
      await this.connection.pool.query(
        `INSERT INTO organizations (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [organizationId, organizationId === 'default' ? 'Default organization' : user.name.trim()],
      );
      const result = await this.connection.pool.query<UserRow>(
        `INSERT INTO users (id, organization_id, email, username, name, role, password_hash, external_subject, status, mfa_enabled, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
         RETURNING ${columns}`,
        [
          randomUUID(),
          organizationId,
          user.email.trim().toLowerCase(),
          user.username ?? null,
          user.name.trim(),
          user.role,
          passwordHash,
          user.externalSubject ?? null,
          user.status ?? 'active',
          user.mustChangePassword ?? false,
        ],
      );
      return toUser(result.rows[0]!);
    } catch (error) {
      // Both the email and the username carry unique indexes, so the constraint name
      // decides which error the caller gets - they are fixed differently.
      if (isUniqueViolation(error))
        throw uniqueViolationOn(error, 'users_username_key')
          ? new DuplicateUsernameError()
          : new DuplicateEmailError();
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
         mfa_enabled = CASE
           WHEN $5::boolean = false THEN false
           WHEN $5::boolean = true AND mfa_secret_ciphertext IS NOT NULL THEN true
           ELSE mfa_enabled
         END,
         mfa_secret_ciphertext = CASE WHEN $5::boolean = false THEN NULL ELSE mfa_secret_ciphertext END,
         mfa_recovery_code_hashes = CASE WHEN $5::boolean = false THEN '{}'::text[] ELSE mfa_recovery_code_hashes END,
         mfa_last_used_counter = CASE WHEN $5::boolean = false THEN NULL ELSE mfa_last_used_counter END,
         password_hash = COALESCE($6, password_hash),
         username = COALESCE($7, username),
         must_change_password = COALESCE($8, must_change_password),
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
        changes.username ?? null,
        changes.mustChangePassword ?? null,
      ],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }

  async updateInOrganization(
    id: string,
    organizationId: string,
    changes: UserChanges,
  ): Promise<UserRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const passwordHash =
      changes.password !== undefined
        ? await hashPassword(changes.password)
        : null;
    const result = await this.connection.pool.query<UserRow>(
      `UPDATE users SET
         name = COALESCE($3, name),
         role = COALESCE($4, role),
         status = COALESCE($5, status),
         mfa_enabled = CASE
           WHEN $6::boolean = false THEN false
           WHEN $6::boolean = true AND mfa_secret_ciphertext IS NOT NULL THEN true
           ELSE mfa_enabled
         END,
         mfa_secret_ciphertext = CASE WHEN $6::boolean = false THEN NULL ELSE mfa_secret_ciphertext END,
         mfa_recovery_code_hashes = CASE WHEN $6::boolean = false THEN '{}'::text[] ELSE mfa_recovery_code_hashes END,
         mfa_last_used_counter = CASE WHEN $6::boolean = false THEN NULL ELSE mfa_last_used_counter END,
         password_hash = COALESCE($7, password_hash),
         username = COALESCE($8, username),
         must_change_password = COALESCE($9, must_change_password),
         updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING ${columns}`,
      [
        id,
        organizationId,
        changes.name ?? null,
        changes.role ?? null,
        changes.status ?? null,
        changes.mfaEnabled ?? null,
        passwordHash,
        changes.username ?? null,
        changes.mustChangePassword ?? null,
      ],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }

  async configureMfa(
    id: string,
    secretCiphertext: string,
    recoveryCodeHashes: readonly string[],
    lastUsedCounter: number,
  ): Promise<UserRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const result = await this.connection.pool.query<UserRow>(
      `UPDATE users SET
         mfa_enabled = true,
         mfa_secret_ciphertext = $2,
         mfa_recovery_code_hashes = $3::text[],
         mfa_last_used_counter = $4,
         updated_at = now()
       WHERE id = $1
       RETURNING ${columns}`,
      [id, secretCiphertext, [...recoveryCodeHashes], lastUsedCounter],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }

  async disableMfa(id: string): Promise<UserRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const result = await this.connection.pool.query<UserRow>(
      `UPDATE users SET
         mfa_enabled = false,
         mfa_secret_ciphertext = NULL,
         mfa_recovery_code_hashes = '{}'::text[],
         mfa_last_used_counter = NULL,
         updated_at = now()
       WHERE id = $1
       RETURNING ${columns}`,
      [id],
    );
    return result.rows[0] ? toUser(result.rows[0]) : undefined;
  }

  async consumeMfaTotpCounter(id: string, counter: number): Promise<boolean> {
    if (!isUuid(id) || !Number.isSafeInteger(counter) || counter < 0) return false;
    const result = await this.connection.pool.query(
      `UPDATE users SET mfa_last_used_counter = $2, updated_at = now()
       WHERE id = $1
         AND mfa_enabled = true
         AND (mfa_last_used_counter IS NULL OR mfa_last_used_counter < $2)`,
      [id, counter],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async consumeMfaRecoveryCode(id: string, codeHash: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.connection.pool.query(
      `UPDATE users SET
         mfa_recovery_code_hashes = array_remove(mfa_recovery_code_hashes, $2),
         updated_at = now()
       WHERE id = $1 AND $2 = ANY(mfa_recovery_code_hashes)`,
      [id, codeHash],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async createMfaChallenge(userId: string, expiresAt: string): Promise<string> {
    const id = randomUUID();
    await this.connection.pool.query(
      `INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES ($1, $2, $3)`,
      [id, userId, expiresAt],
    );
    // Opportunistic bounded cleanup keeps abandoned challenges from accumulating.
    await this.connection.pool.query(
      `DELETE FROM mfa_challenges WHERE expires_at < now() - interval '1 day'`,
    );
    return id;
  }

  async consumeMfaChallenge(
    id: string,
    userId: string,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    if (!isUuid(id) || !isUuid(userId)) return false;
    const result = await this.connection.pool.query(
      `UPDATE mfa_challenges SET used_at = $3
       WHERE id = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > $3`,
      [id, userId, now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async createPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<void> {
    if (!isUuid(userId)) return;
    const client = await this.connection.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE password_reset_tokens SET used_at = now()
         WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      );
      await client.query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), userId, tokenHash, expiresAt],
      );
      await client.query(
        `DELETE FROM password_reset_tokens
         WHERE expires_at < now() - interval '1 day'`,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async resetPasswordWithToken(
    tokenHash: string,
    newPassword: string,
    now = new Date().toISOString(),
  ): Promise<UserRecord | undefined> {
    const client = await this.connection.pool.connect();
    try {
      await client.query('BEGIN');
      const token = await client.query<{ user_id: string; password_hash: string | null }>(
        `SELECT token.user_id, users.password_hash
           FROM password_reset_tokens token
           JOIN users ON users.id = token.user_id
          WHERE token.token_hash = $1
            AND token.used_at IS NULL
            AND token.expires_at > $2
            AND users.status = 'active'
          FOR UPDATE OF token, users`,
        [tokenHash, now],
      );
      const userId = token.rows[0]?.user_id;
      if (!userId) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (await verifyPassword(newPassword, token.rows[0]!.password_hash)) {
        await client.query('ROLLBACK');
        throw new PasswordReuseError();
      }
      const passwordHash = await hashPassword(newPassword);
      await client.query(
        `UPDATE password_reset_tokens SET used_at = $2
         WHERE user_id = $1 AND used_at IS NULL`,
        [userId, now],
      );
      await client.query(
        `UPDATE mfa_challenges SET used_at = $2
         WHERE user_id = $1 AND used_at IS NULL`,
        [userId, now],
      );
      const updated = await client.query<UserRow>(
        `UPDATE users SET
           password_hash = $2,
           must_change_password = false,
           session_version = session_version + 1,
           updated_at = $3
         WHERE id = $1
         RETURNING ${columns}`,
        [userId, passwordHash, now],
      );
      await client.query('COMMIT');
      return updated.rows[0] ? toUser(updated.rows[0]) : undefined;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
  organization_id: string | null;
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
  chain_sequence: string;
  previous_hash: string | null;
  record_hash: string | null;
  integrity_version: number | null;
  integrity_key_id: string | null;
}

const toAudit = (row: AuditRow): AuditRecord => ({
  id: row.id,
  organizationId: row.organization_id,
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
  ...(row.record_hash && row.integrity_version === 1 && row.integrity_key_id
    ? {
        integrity: {
          algorithm: AUDIT_INTEGRITY_ALGORITHM,
          keyId: row.integrity_key_id,
          sequence: Number(row.chain_sequence),
          previousHash: row.previous_hash,
          hash: row.record_hash,
        },
      }
    : {}),
});

/**
 * Append-only audit storage.
 *
 * There is no update or delete method, and the table refuses both anyway (see
 * migration 0005), so the absence here is a statement rather than an omission.
 */
export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(
    private readonly connection: PostgresConnection,
    private readonly integrityKey: string,
    private readonly keyId = 'primary',
  ) {}

  async record(entry: AuditEntry): Promise<AuditRecord> {
    if (!this.integrityKey)
      throw new Error('Audit integrity key is not configured');
    const client = await this.connection.pool.connect();
    try {
      await client.query('BEGIN');
      // One global chain requires a single writer while its head is read and replaced.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('faultline:audit-integrity'))",
      );
      const sequence = Number(
        (
          await client.query<{ sequence: string }>(
            "SELECT nextval(pg_get_serial_sequence('audit_log', 'chain_sequence'))::text AS sequence",
          )
        ).rows[0]!.sequence,
      );
      const previousHash = (
        await client.query<{ record_hash: string }>(
          `SELECT record_hash FROM audit_log
             WHERE record_hash IS NOT NULL
             ORDER BY chain_sequence DESC LIMIT 1`,
        )
      ).rows[0]?.record_hash ?? null;
      const base = {
        id: entry.id ?? randomUUID(),
        organizationId: entry.organizationId,
        userId: entry.userId && isUuid(entry.userId) ? entry.userId : null,
        actor: entry.actor,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        outcome: entry.outcome,
        ip: entry.ip,
        userAgent: entry.userAgent,
        metadata: entry.metadata ?? {},
        occurredAt: entry.occurredAt
          ? new Date(entry.occurredAt).toISOString()
          : new Date().toISOString(),
      };
      const recordHash = computeAuditHash(
        base,
        sequence,
        previousHash,
        this.keyId,
        this.integrityKey,
      );
      const result = await client.query<AuditRow>(
        `INSERT INTO audit_log
           (id, organization_id, user_id, actor, action, resource_type, resource_id, outcome, ip,
            user_agent, metadata, occurred_at, chain_sequence, previous_hash,
            record_hash, integrity_version, integrity_key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz,
                 $13, $14, $15, 1, $16)
         RETURNING id, organization_id, user_id, actor, action, resource_type, resource_id, outcome,
                   ip, user_agent, metadata, occurred_at, chain_sequence::text,
                   previous_hash, record_hash, integrity_version, integrity_key_id`,
        [
          base.id,
          base.organizationId,
          base.userId,
          base.actor,
          base.action,
          base.resourceType,
          base.resourceId,
          base.outcome,
          base.ip,
          base.userAgent,
          JSON.stringify(base.metadata),
          base.occurredAt,
          sequence,
          previousHash,
          recordHash,
          this.keyId,
        ],
      );
      await client.query('COMMIT');
      return toAudit(result.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(filter: AuditFilter = {}): Promise<readonly AuditRecord[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const where = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace('?', `$${values.length}`));
    };
    if (filter.organizationId)
      where('organization_id = ?', filter.organizationId);
    if (filter.userId && isUuid(filter.userId)) where('user_id = ?', filter.userId);
    if (filter.action) where('action = ?', filter.action);
    if (filter.resourceType) where('resource_type = ?', filter.resourceType);
    if (filter.resourceId) where('resource_id = ?', filter.resourceId);
    if (filter.outcome) where('outcome = ?', filter.outcome);
    if (filter.since) where('occurred_at >= ?::timestamptz', filter.since);
    if (filter.until) where('occurred_at <= ?::timestamptz', filter.until);
    values.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const result = await this.connection.pool.query<AuditRow>(
      `SELECT id, organization_id, user_id, actor, action, resource_type, resource_id, outcome, ip,
              user_agent, metadata, occurred_at, chain_sequence::text, previous_hash,
              record_hash, integrity_version, integrity_key_id
         FROM audit_log
         ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
         ORDER BY occurred_at DESC
         LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toAudit);
  }

  async verifyIntegrity(): Promise<AuditIntegrityReport> {
    if (!this.integrityKey)
      throw new Error('Audit integrity key is not configured');
    const rows = (
      await this.connection.pool.query<AuditRow>(
        `SELECT id, organization_id, user_id, actor, action, resource_type, resource_id, outcome, ip,
                user_agent, metadata, occurred_at, chain_sequence::text, previous_hash,
                record_hash, integrity_version, integrity_key_id
           FROM audit_log ORDER BY chain_sequence ASC`,
      )
    ).rows;
    let previousHash: string | null = null;
    let checkedRecords = 0;
    const unsignedRecords = rows.filter((row) => !row.record_hash).length;
    for (const row of rows) {
      const record = toAudit(row);
      if (!record.integrity) continue;
      const { integrity: _integrity, ...base } = record;
      const expected = computeAuditHash(
        base,
        record.integrity.sequence,
        previousHash,
        record.integrity.keyId,
        this.integrityKey,
      );
      if (
        record.integrity.keyId !== this.keyId ||
        record.integrity.previousHash !== previousHash ||
        !auditHashesEqual(record.integrity.hash, expected)
      )
        return {
          valid: false,
          checkedRecords,
          unsignedRecords,
          headHash: previousHash,
          firstInvalidRecordId: record.id,
        };
      previousHash = record.integrity.hash;
      checkedRecords += 1;
    }
    return {
      valid: true,
      checkedRecords,
      unsignedRecords,
      headHash: previousHash,
    };
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values reaching these adapters come from tokens and URLs; a non-uuid is a miss. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

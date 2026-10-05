import { randomUUID } from 'node:crypto';
import type { ProjectAssignment, UserStatus } from './identity';
import { ROLES, type Role } from './roles';
import { hashPassword, verifyPassword } from './passwords';
import type {
  AuditEntry,
  AuditFilter,
  AuditLogRepository,
  AuditRecord,
  AuditIntegrityReport,
} from './audit';
import {
  AUDIT_INTEGRITY_ALGORITHM,
  auditHashesEqual,
  computeAuditHash,
} from './audit-integrity';

/** A stored user. `passwordHash` never leaves the repository layer. */
export interface UserRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly username: string | null;
  readonly name: string;
  readonly role: Role;
  readonly status: UserStatus;
  readonly mfaEnabled: boolean;
  /** AES-GCM ciphertext; exposed only to authentication services, never presenters. */
  readonly mfaSecretCiphertext: string | null;
  /** HMAC digests. The plaintext recovery codes are returned once during enrollment. */
  readonly mfaRecoveryCodeHashes: readonly string[];
  readonly mfaLastUsedCounter: number | null;
  /** Incremented by security-sensitive credential recovery to revoke older JWTs. */
  readonly sessionVersion: number;
  /** True while the account still holds a temporary password it must replace. */
  readonly mustChangePassword: boolean;
  /** Absent for users whose credentials live in an external identity provider. */
  readonly passwordHash?: string | null;
  /** The subject claim an SSO/OIDC provider will present. Unused until one is wired. */
  readonly externalSubject?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewUser {
  organizationId?: string;
  email: string;
  name: string;
  role: Role;
  username?: string | null;
  password?: string;
  status?: UserStatus;
  mfaEnabled?: boolean;
  mustChangePassword?: boolean;
  externalSubject?: string | null;
}

export interface UserChanges {
  name?: string;
  role?: Role;
  status?: UserStatus;
  password?: string;
  mfaEnabled?: boolean;
  mustChangePassword?: boolean;
  username?: string;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | undefined>;
  findByIdInOrganization(
    id: string,
    organizationId: string,
  ): Promise<UserRecord | undefined>;
  /** Case-insensitive: an email is one identity however it was typed. */
  findByEmail(email: string): Promise<UserRecord | undefined>;
  /** Case-insensitive, like email: one handle however it was typed. */
  findByUsername(username: string): Promise<UserRecord | undefined>;
  findByExternalSubject(subject: string): Promise<UserRecord | undefined>;
  list(): Promise<readonly UserRecord[]>;
  listByOrganization(organizationId: string): Promise<readonly UserRecord[]>;
  create(user: NewUser): Promise<UserRecord>;
  update(id: string, changes: UserChanges): Promise<UserRecord | undefined>;
  updateInOrganization(
    id: string,
    organizationId: string,
    changes: UserChanges,
  ): Promise<UserRecord | undefined>;
  configureMfa(
    id: string,
    secretCiphertext: string,
    recoveryCodeHashes: readonly string[],
    lastUsedCounter: number,
  ): Promise<UserRecord | undefined>;
  disableMfa(id: string): Promise<UserRecord | undefined>;
  consumeMfaTotpCounter(id: string, counter: number): Promise<boolean>;
  consumeMfaRecoveryCode(id: string, codeHash: string): Promise<boolean>;
  createMfaChallenge(userId: string, expiresAt: string): Promise<string>;
  consumeMfaChallenge(id: string, userId: string, now?: string): Promise<boolean>;
  createPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<void>;
  /** Atomically consumes the token, replaces the password, and revokes old sessions. */
  resetPasswordWithToken(
    tokenHash: string,
    newPassword: string,
    now?: string,
  ): Promise<UserRecord | undefined>;
}

export interface ProjectAssignmentRepository {
  listForUser(userId: string): Promise<readonly ProjectAssignment[]>;
  listForUsers(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ProjectAssignment[]>>;
  listUserIdsForProject(projectId: string): Promise<readonly string[]>;
  assign(
    userId: string,
    projectId: string,
    assignedBy: string,
    environments?: readonly string[],
  ): Promise<ProjectAssignment>;
  remove(userId: string, projectId: string): Promise<boolean>;
}

export const USER_REPOSITORY = Symbol('faultline.user-repository');
export const PROJECT_ASSIGNMENT_REPOSITORY = Symbol(
  'faultline.project-assignment-repository',
);

export class UnknownUserError extends Error {
  constructor() {
    super('User not found');
    this.name = 'UnknownUserError';
  }
}
export class DuplicateEmailError extends Error {
  constructor() {
    super('A user with that email already exists');
    this.name = 'DuplicateEmailError';
  }
}
export class DuplicateUsernameError extends Error {
  constructor() {
    super('That username is already taken');
    this.name = 'DuplicateUsernameError';
  }
}

export class PasswordReuseError extends Error {
  constructor() {
    super('New password must be different from the current password');
    this.name = 'PasswordReuseError';
  }
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Development and test doubles.
 *
 * They exist so the API guards can be exercised without PostgreSQL, exactly as the
 * incident and telemetry packages already do. Production wiring uses the PostgreSQL
 * adapters in `@faultline/database`.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly mfaChallenges = new Map<
    string,
    { userId: string; expiresAt: string; used: boolean }
  >();
  private readonly passwordResetTokens = new Map<
    string,
    { userId: string; expiresAt: string; used: boolean }
  >();

  async findById(id: string): Promise<UserRecord | undefined> {
    return this.users.get(id);
  }
  async findByIdInOrganization(
    id: string,
    organizationId: string,
  ): Promise<UserRecord | undefined> {
    const user = this.users.get(id);
    return user?.organizationId === organizationId ? user : undefined;
  }
  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const wanted = normalizeEmail(email);
    return [...this.users.values()].find((user) => user.email === wanted);
  }
  async findByUsername(username: string): Promise<UserRecord | undefined> {
    const wanted = username.trim().toLowerCase();
    return [...this.users.values()].find(
      (user) => user.username?.toLowerCase() === wanted,
    );
  }
  async findByExternalSubject(
    subject: string,
  ): Promise<UserRecord | undefined> {
    return [...this.users.values()].find(
      (user) => user.externalSubject === subject,
    );
  }
  async list(): Promise<readonly UserRecord[]> {
    return [...this.users.values()].sort((a, b) =>
      a.email.localeCompare(b.email),
    );
  }
  async listByOrganization(
    organizationId: string,
  ): Promise<readonly UserRecord[]> {
    return (await this.list()).filter(
      (user) => user.organizationId === organizationId,
    );
  }
  async create(user: NewUser): Promise<UserRecord> {
    const email = normalizeEmail(user.email);
    if (await this.findByEmail(email)) throw new DuplicateEmailError();
    if (user.username && (await this.findByUsername(user.username)))
      throw new DuplicateUsernameError();
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: randomUUID(),
      organizationId: user.organizationId ?? 'default',
      email,
      username: user.username ?? null,
      name: user.name,
      role: user.role,
      status: user.status ?? 'active',
      // Enrollment is the only way to enable MFA: a boolean without a secret would
      // create an account that can neither verify nor recover.
      mfaEnabled: false,
      mfaSecretCiphertext: null,
      mfaRecoveryCodeHashes: [],
      mfaLastUsedCounter: null,
      sessionVersion: 1,
      mustChangePassword: user.mustChangePassword ?? false,
      passwordHash: user.password ? await hashPassword(user.password) : null,
      externalSubject: user.externalSubject ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(record.id, record);
    return record;
  }
  async update(
    id: string,
    changes: UserChanges,
  ): Promise<UserRecord | undefined> {
    const existing = this.users.get(id);
    if (!existing) return undefined;
    const updated: UserRecord = {
      ...existing,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.role !== undefined ? { role: changes.role } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.mfaEnabled !== undefined
        ? changes.mfaEnabled
          ? { mfaEnabled: existing.mfaSecretCiphertext !== null }
          : {
              mfaEnabled: false,
              mfaSecretCiphertext: null,
              mfaRecoveryCodeHashes: [],
              mfaLastUsedCounter: null,
            }
        : {}),
      ...(changes.username !== undefined
        ? { username: changes.username }
        : {}),
      ...(changes.mustChangePassword !== undefined
        ? { mustChangePassword: changes.mustChangePassword }
        : {}),
      ...(changes.password !== undefined
        ? { passwordHash: await hashPassword(changes.password) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, updated);
    return updated;
  }

  async updateInOrganization(
    id: string,
    organizationId: string,
    changes: UserChanges,
  ): Promise<UserRecord | undefined> {
    const existing = await this.findByIdInOrganization(id, organizationId);
    return existing ? this.update(id, changes) : undefined;
  }

  async configureMfa(
    id: string,
    secretCiphertext: string,
    recoveryCodeHashes: readonly string[],
    lastUsedCounter: number,
  ): Promise<UserRecord | undefined> {
    const existing = this.users.get(id);
    if (!existing) return undefined;
    const updated: UserRecord = {
      ...existing,
      mfaEnabled: true,
      mfaSecretCiphertext: secretCiphertext,
      mfaRecoveryCodeHashes: [...recoveryCodeHashes],
      mfaLastUsedCounter: lastUsedCounter,
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, updated);
    return updated;
  }

  async disableMfa(id: string): Promise<UserRecord | undefined> {
    return this.update(id, { mfaEnabled: false });
  }

  async consumeMfaTotpCounter(id: string, counter: number): Promise<boolean> {
    const existing = this.users.get(id);
    if (!existing || (existing.mfaLastUsedCounter !== null && existing.mfaLastUsedCounter >= counter))
      return false;
    this.users.set(id, { ...existing, mfaLastUsedCounter: counter });
    return true;
  }

  async consumeMfaRecoveryCode(id: string, codeHash: string): Promise<boolean> {
    const existing = this.users.get(id);
    if (!existing || !existing.mfaRecoveryCodeHashes.includes(codeHash)) return false;
    this.users.set(id, {
      ...existing,
      mfaRecoveryCodeHashes: existing.mfaRecoveryCodeHashes.filter((hash) => hash !== codeHash),
    });
    return true;
  }

  async createMfaChallenge(userId: string, expiresAt: string): Promise<string> {
    const id = randomUUID();
    this.mfaChallenges.set(id, { userId, expiresAt, used: false });
    return id;
  }

  async consumeMfaChallenge(id: string, userId: string, now = new Date().toISOString()): Promise<boolean> {
    const challenge = this.mfaChallenges.get(id);
    if (!challenge || challenge.userId !== userId || challenge.used || challenge.expiresAt <= now)
      return false;
    challenge.used = true;
    return true;
  }

  async createPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<void> {
    for (const token of this.passwordResetTokens.values()) {
      if (token.userId === userId && !token.used) token.used = true;
    }
    this.passwordResetTokens.set(tokenHash, {
      userId,
      expiresAt,
      used: false,
    });
  }

  async resetPasswordWithToken(
    tokenHash: string,
    newPassword: string,
    now = new Date().toISOString(),
  ): Promise<UserRecord | undefined> {
    const token = this.passwordResetTokens.get(tokenHash);
    if (!token || token.used || token.expiresAt <= now) return undefined;
    const existing = this.users.get(token.userId);
    if (!existing || existing.status !== 'active') return undefined;
    if (await verifyPassword(newPassword, existing.passwordHash))
      throw new PasswordReuseError();
    const updated: UserRecord = {
      ...existing,
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      sessionVersion: existing.sessionVersion + 1,
      updatedAt: now,
    };
    token.used = true;
    for (const candidate of this.passwordResetTokens.values()) {
      if (candidate.userId === existing.id) candidate.used = true;
    }
    for (const challenge of this.mfaChallenges.values()) {
      if (challenge.userId === existing.id) challenge.used = true;
    }
    this.users.set(existing.id, updated);
    return updated;
  }
}

export class InMemoryProjectAssignmentRepository
  implements ProjectAssignmentRepository
{
  private readonly byUser = new Map<string, Map<string, ProjectAssignment>>();

  async listForUser(userId: string): Promise<readonly ProjectAssignment[]> {
    return [...(this.byUser.get(userId)?.values() ?? [])];
  }
  async listForUsers(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ProjectAssignment[]>> {
    const result = new Map<string, readonly ProjectAssignment[]>();
    for (const userId of userIds)
      result.set(userId, await this.listForUser(userId));
    return result;
  }
  async listUserIdsForProject(projectId: string): Promise<readonly string[]> {
    return [...this.byUser.entries()]
      .filter(([, projects]) => projects.has(projectId))
      .map(([userId]) => userId);
  }
  async assign(
    userId: string,
    projectId: string,
    assignedBy: string,
    environments?: readonly string[],
  ): Promise<ProjectAssignment> {
    const assignment: ProjectAssignment = {
      projectId,
      assignedBy,
      assignedAt: new Date().toISOString(),
      ...(environments?.length ? { environments: [...environments] } : {}),
    };
    const projects = this.byUser.get(userId) ?? new Map();
    projects.set(projectId, assignment);
    this.byUser.set(userId, projects);
    return assignment;
  }
  async remove(userId: string, projectId: string): Promise<boolean> {
    return this.byUser.get(userId)?.delete(projectId) ?? false;
  }
}

export class InMemoryAuditLogRepository implements AuditLogRepository {
  private readonly records: AuditRecord[] = [];

  constructor(
    private readonly integrityKey = 'faultline-test-audit-integrity-key',
    private readonly keyId = 'test',
  ) {}

  async record(entry: AuditEntry): Promise<AuditRecord> {
    const base = {
      id: entry.id ?? randomUUID(),
      occurredAt: entry.occurredAt
        ? new Date(entry.occurredAt).toISOString()
        : new Date().toISOString(),
      organizationId: entry.organizationId,
      userId: entry.userId,
      actor: entry.actor,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      outcome: entry.outcome,
      ip: entry.ip,
      userAgent: entry.userAgent,
      metadata: entry.metadata,
    };
    const previousHash = this.records.at(-1)?.integrity?.hash ?? null;
    const sequence = this.records.length + 1;
    const hash = computeAuditHash(
      base,
      sequence,
      previousHash,
      this.keyId,
      this.integrityKey,
    );
    const record: AuditRecord = {
      ...base,
      integrity: {
        algorithm: AUDIT_INTEGRITY_ALGORITHM,
        keyId: this.keyId,
        sequence,
        previousHash,
        hash,
      },
    };
    this.records.push(record);
    return record;
  }
  async list(filter: AuditFilter = {}): Promise<readonly AuditRecord[]> {
    return this.records
      .filter(
        (record) =>
          (!filter.organizationId ||
            record.organizationId === filter.organizationId) &&
          (!filter.userId || record.userId === filter.userId) &&
          (!filter.action || record.action === filter.action) &&
          (!filter.resourceType ||
            record.resourceType === filter.resourceType) &&
          (!filter.resourceId || record.resourceId === filter.resourceId) &&
          (!filter.outcome || record.outcome === filter.outcome) &&
          (!filter.since || record.occurredAt >= filter.since) &&
          (!filter.until || record.occurredAt <= filter.until),
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, filter.limit ?? 200);
  }

  async verifyIntegrity(): Promise<AuditIntegrityReport> {
    let previousHash: string | null = null;
    let checkedRecords = 0;
    for (const record of this.records) {
      const integrity = record.integrity;
      if (!integrity) continue;
      const { integrity: _integrity, ...base } = record;
      const expected = computeAuditHash(
        base,
        integrity.sequence,
        previousHash,
        integrity.keyId,
        this.integrityKey,
      );
      if (
        integrity.previousHash !== previousHash ||
        !auditHashesEqual(integrity.hash, expected)
      )
        return {
          valid: false,
          checkedRecords,
          unsignedRecords: this.records.length - checkedRecords,
          headHash: previousHash,
          firstInvalidRecordId: record.id,
        };
      previousHash = integrity.hash;
      checkedRecords += 1;
    }
    return {
      valid: true,
      checkedRecords,
      unsignedRecords: this.records.length - checkedRecords,
      headHash: previousHash,
    };
  }
}

let developmentUsers: InMemoryUserRepository | undefined;
let developmentAssignments: InMemoryProjectAssignmentRepository | undefined;
let developmentAudit: InMemoryAuditLogRepository | undefined;

export function getDevelopmentUserRepository(): UserRepository {
  return (developmentUsers ??= new InMemoryUserRepository());
}
export function getDevelopmentProjectAssignmentRepository(): ProjectAssignmentRepository {
  return (developmentAssignments ??= new InMemoryProjectAssignmentRepository());
}
export function getDevelopmentAuditLogRepository(): AuditLogRepository {
  return (developmentAudit ??= new InMemoryAuditLogRepository());
}

export { ROLES };

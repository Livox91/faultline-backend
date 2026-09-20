import { randomUUID } from 'node:crypto';
import type { ProjectAssignment, UserStatus } from './identity';
import { ROLES, type Role } from './roles';
import { hashPassword } from './passwords';
import type {
  AuditEntry,
  AuditFilter,
  AuditLogRepository,
  AuditRecord,
} from './audit';

/** A stored user. `passwordHash` never leaves the repository layer. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly status: UserStatus;
  readonly mfaEnabled: boolean;
  /** Absent for users whose credentials live in an external identity provider. */
  readonly passwordHash?: string | null;
  /** The subject claim an SSO/OIDC provider will present. Unused until one is wired. */
  readonly externalSubject?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  password?: string;
  status?: UserStatus;
  mfaEnabled?: boolean;
  externalSubject?: string | null;
}

export interface UserChanges {
  name?: string;
  role?: Role;
  status?: UserStatus;
  password?: string;
  mfaEnabled?: boolean;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | undefined>;
  /** Case-insensitive: an email is one identity however it was typed. */
  findByEmail(email: string): Promise<UserRecord | undefined>;
  findByExternalSubject(subject: string): Promise<UserRecord | undefined>;
  list(): Promise<readonly UserRecord[]>;
  create(user: NewUser): Promise<UserRecord>;
  update(id: string, changes: UserChanges): Promise<UserRecord | undefined>;
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

  async findById(id: string): Promise<UserRecord | undefined> {
    return this.users.get(id);
  }
  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const wanted = normalizeEmail(email);
    return [...this.users.values()].find((user) => user.email === wanted);
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
  async create(user: NewUser): Promise<UserRecord> {
    const email = normalizeEmail(user.email);
    if (await this.findByEmail(email)) throw new DuplicateEmailError();
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: randomUUID(),
      email,
      name: user.name,
      role: user.role,
      status: user.status ?? 'active',
      mfaEnabled: user.mfaEnabled ?? false,
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
        ? { mfaEnabled: changes.mfaEnabled }
        : {}),
      ...(changes.password !== undefined
        ? { passwordHash: await hashPassword(changes.password) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, updated);
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

  async record(entry: AuditEntry): Promise<AuditRecord> {
    const record: AuditRecord = {
      id: entry.id ?? randomUUID(),
      occurredAt: entry.occurredAt ?? new Date().toISOString(),
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
    this.records.push(record);
    return record;
  }
  async list(filter: AuditFilter = {}): Promise<readonly AuditRecord[]> {
    return this.records
      .filter(
        (record) =>
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

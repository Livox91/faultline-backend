import {
  PERMISSIONS,
  ROLES,
  permissionsFor,
  type Permission,
  type Role,
} from './roles';

export type UserStatus = 'active' | 'disabled';

/**
 * One project a user may work on.
 *
 * `environments` is the seam for the environment-level access that comes later: an
 * empty list means "every environment of this project", so today's assignments keep
 * working unchanged once environments start being enforced.
 */
export interface ProjectAssignment {
  readonly projectId: string;
  readonly environments?: readonly string[];
  readonly assignedAt?: string;
  readonly assignedBy?: string;
}

/**
 * The identity a request acts under.
 *
 * Assembled from the token's subject plus a fresh read of the user and their
 * assignments, never from claims the client sent: a token outlives an assignment being
 * revoked, so the assignment list must come from storage on every request.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly status: UserStatus;
  readonly mfaEnabled: boolean;
  readonly assignments: readonly ProjectAssignment[];
}

export function isAdmin(user: Pick<AuthenticatedUser, 'role'>): boolean {
  return user.role === ROLES.ADMIN;
}

export function hasRole(
  user: Pick<AuthenticatedUser, 'role'> | null | undefined,
  ...roles: readonly Role[]
): boolean {
  return !!user && roles.includes(user.role);
}

export function hasPermission(
  user: Pick<AuthenticatedUser, 'role'> | null | undefined,
  permission: Permission,
): boolean {
  return !!user && permissionsFor(user.role).includes(permission);
}

/** The projects a non-admin may name. Admins are not enumerated: they see everything. */
export function assignedProjectIds(
  user: Pick<AuthenticatedUser, 'assignments'>,
): readonly string[] {
  return user.assignments.map((assignment) => assignment.projectId);
}

/**
 * The single question every project-scoped read and write asks.
 *
 * An Admin passes for any project. Anyone else passes only for a project they hold an
 * assignment to, which makes the assignment table the one source of truth for engineer
 * access - there is no second place to grant it.
 */
export function hasProjectAccess(
  user: AuthenticatedUser | null | undefined,
  projectId: string | null | undefined,
): boolean {
  if (!user || user.status !== 'active') return false;
  if (isAdmin(user)) return true;
  if (!projectId) return false;
  return user.assignments.some(
    (assignment) => assignment.projectId === projectId,
  );
}

/**
 * Environment-level access, ahead of the environments themselves.
 *
 * Today every caller passes `undefined` and this is a no-op, but the check already sits
 * on the path a request takes, so turning environments on later is a change to the data
 * rather than a change to every call site.
 */
export function hasEnvironmentAccess(
  user: AuthenticatedUser | null | undefined,
  projectId: string,
  environment?: string,
): boolean {
  if (!hasProjectAccess(user, projectId)) return false;
  if (!environment || isAdmin(user!)) return true;
  const assignment = user!.assignments.find(
    (candidate) => candidate.projectId === projectId,
  );
  const environments = assignment?.environments;
  return !environments?.length || environments.includes(environment);
}

/** Raised by the rules; the HTTP layer decides the status code. */
export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly reason: 'forbidden' | 'unauthenticated',
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export function assertProjectAccess(
  user: AuthenticatedUser | null | undefined,
  projectId: string | null | undefined,
): void {
  if (!user) throw new AuthorizationError('Authentication required', 'unauthenticated');
  if (!hasProjectAccess(user, projectId))
    throw new AuthorizationError(
      'You do not have access to this project',
      'forbidden',
    );
}

export function assertPermission(
  user: AuthenticatedUser | null | undefined,
  permission: Permission,
): void {
  if (!user) throw new AuthorizationError('Authentication required', 'unauthenticated');
  if (!hasPermission(user, permission))
    throw new AuthorizationError(
      'Your role does not permit this action',
      'forbidden',
    );
}

/** What the client is told about itself. Never includes a credential. */
export function presentUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    mfaEnabled: user.mfaEnabled,
    permissions: permissionsFor(user.role),
    // Admins are not listed against projects: their access is not enumerable, and a
    // client that received a list would wrongly treat it as the limit of their reach.
    projectIds: isAdmin(user) ? null : assignedProjectIds(user),
  };
}

export { PERMISSIONS, ROLES };

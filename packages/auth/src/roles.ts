/**
 * The authorization vocabulary, in one place.
 *
 * Roles, the permissions each role carries and the project-access rule all live here so
 * that a controller, a guard and the React client can never disagree about what a role
 * means. Nothing in this file imports a framework: the HTTP layer maps the errors it
 * raises onto status codes, and the rules stay testable on their own.
 */

export const ROLES = {
  ADMIN: 'admin',
  ONSITE_ENGINEER: 'onsiteengineer',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const roleNames: readonly Role[] = Object.freeze(Object.values(ROLES));

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && roleNames.includes(value as Role);
}

/**
 * Normalises the spellings a human may type into a stored role.
 *
 * Accepted because operators and seed scripts write roles by hand; anything else is
 * rejected rather than guessed at.
 */
export function parseRole(value: unknown): Role | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return roleNames.find((role) => role === normalized);
}

export const PERMISSIONS = {
  PROJECT_VIEW: 'project:view',
  PROJECT_CREATE: 'project:create',
  PROJECT_EDIT: 'project:edit',
  PROJECT_DELETE: 'project:delete',
  PROJECT_ASSIGN: 'project:assign',
  INCIDENT_VIEW: 'incident:view',
  REMEDIATION_ACT: 'remediation:act',
  USER_VIEW: 'user:view',
  USER_MANAGE: 'user:manage',
  AUDIT_VIEW: 'audit:view',
  SETTINGS_MANAGE: 'settings:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * What each role may do at all, before any project is named.
 *
 * An Onsite Engineer's list is deliberately short: everything else they can do is
 * scoped by assignment, which is a separate check (`hasProjectAccess`) rather than a
 * permission, because a permission answers "may this role ever" and an assignment
 * answers "may this user, here".
 */
const rolePermissions: Readonly<Record<Role, readonly Permission[]>> =
  Object.freeze({
    [ROLES.ADMIN]: Object.freeze([
      PERMISSIONS.PROJECT_VIEW,
      PERMISSIONS.PROJECT_CREATE,
      PERMISSIONS.PROJECT_EDIT,
      PERMISSIONS.PROJECT_DELETE,
      PERMISSIONS.PROJECT_ASSIGN,
      PERMISSIONS.INCIDENT_VIEW,
      PERMISSIONS.REMEDIATION_ACT,
      PERMISSIONS.USER_VIEW,
      PERMISSIONS.USER_MANAGE,
      PERMISSIONS.AUDIT_VIEW,
      PERMISSIONS.SETTINGS_MANAGE,
    ]),
    [ROLES.ONSITE_ENGINEER]: Object.freeze([
      PERMISSIONS.PROJECT_VIEW,
      PERMISSIONS.INCIDENT_VIEW,
      PERMISSIONS.REMEDIATION_ACT,
    ]),
  });

export function permissionsFor(role: Role): readonly Permission[] {
  return rolePermissions[role];
}

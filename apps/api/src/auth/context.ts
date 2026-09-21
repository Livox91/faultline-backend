import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, Permission, Role } from '@faultline/auth';
import type { PlanFeature } from '@faultline/billing';

/**
 * The request as the guards leave it.
 *
 * Typed structurally rather than against Express so the guards stay testable with a
 * plain object, and so swapping the HTTP adapter does not reach into authorization.
 */
export interface RequestWithUser {
  user?: AuthenticatedUser;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  method?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export const IS_PUBLIC = 'faultline.auth.public';
export const REQUIRED_ROLES = 'faultline.auth.roles';
export const REQUIRED_PERMISSION = 'faultline.auth.permission';
export const PROJECT_SOURCE = 'faultline.auth.project-source';
export const PASSWORD_CHANGE_EXEMPT = 'faultline.auth.password-change-exempt';
export const REQUIRED_FEATURE = 'faultline.billing.feature';

/**
 * Opts a route out of authentication.
 *
 * Authentication is on by default via a global guard, so forgetting a decorator makes a
 * route private rather than open. Only liveness, readiness and the login endpoints
 * carry this.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restricts a route to the listed roles. */
export const Roles = (...roles: readonly Role[]) =>
  SetMetadata(REQUIRED_ROLES, roles);

/** Restricts a route to holders of a permission, whatever role carries it. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/**
 * Lets a route run for an account that still owes a password change.
 *
 * An account provisioned with an emailed temporary password is authenticated but not
 * yet trusted: the credential that opened it travelled through a mailbox. Every route
 * is therefore closed to it *except* the few needed to get out of that state, and those
 * few have to say so explicitly. As with `@Public()`, the direction matters - a route
 * added later is closed to such an account unless someone opts it in.
 */
export const AllowWhilePasswordChangePending = () =>
  SetMetadata(PASSWORD_CHANGE_EXEMPT, true);

/**
 * Restricts a route to accounts whose subscription tier includes a module.
 *
 * A different question from `@RequirePermission`, and deliberately a different
 * decorator: permission asks whether this person may do the thing, this asks whether
 * the thing was bought. Both can apply, and both must pass - an Admin on Basic is still
 * an Admin, there is simply no Voice Call Agent on their plan to administer.
 *
 * Declared per route rather than checked inside handlers for the same reason the
 * project check is: one place it can be forgotten, and it is visible in the signature.
 */
export const RequiresFeature = (feature: PlanFeature) =>
  SetMetadata(REQUIRED_FEATURE, feature);

export type ProjectSource = { in: 'param' | 'query' | 'body'; name: string };

/**
 * Declares where the project this route acts on is named, so the guard can check the
 * caller's assignment before the handler runs.
 *
 * Marking the location rather than checking inside each handler is what makes
 * `/projects/:id` and `/api/projects/:id` behave identically for an unassigned
 * engineer: there is one place the check can be forgotten, and it is declarative.
 */
export const RequiresProjectAccess = (
  name: string,
  where: ProjectSource['in'] = 'param',
) => SetMetadata(PROJECT_SOURCE, { in: where, name } satisfies ProjectSource);

/** Injects the authenticated user. Present on every non-public route by construction. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<RequestWithUser>().user!,
);

export function clientAddress(request: RequestWithUser): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (
    first?.split(',')[0]?.trim() ||
    request.ip ||
    request.socket?.remoteAddress ||
    null
  );
}

export function userAgent(request: RequestWithUser): string | null {
  const value = request.headers['user-agent'];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

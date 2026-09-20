import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, Permission, Role } from '@faultline/auth';

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

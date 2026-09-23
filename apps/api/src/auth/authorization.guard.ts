import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUDIT_ACTIONS,
  hasPermission,
  hasProjectAccess,
  hasRole,
  type Permission,
  type Role,
} from '@faultline/auth';
import { AuditTrail } from './audit-trail';
import {
  IS_PUBLIC,
  PASSWORD_CHANGE_EXEMPT,
  PROJECT_SOURCE,
  REQUIRED_PERMISSION,
  REQUIRED_ROLES,
  type ProjectSource,
  type RequestWithUser,
} from './context';

/**
 * Enforces role, permission and project assignment, in that order.
 *
 * All three live in one global guard rather than scattered through handlers so that the
 * rule a route is subject to is visible in its decorators, and so that every denial
 * takes the same path into the audit trail. A handler cannot run before this has
 * agreed, which is what makes changing `/projects/a` to `/projects/b` in the URL bar
 * identical to calling the API directly with curl: neither reaches the controller.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditTrail,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    // The authentication guard runs first and throws 401 when there is no user; this
    // is the belt to that braces, in case guard order is ever changed.
    if (!user) throw new ForbiddenException('Authentication required');

    /**
     * An account holding an emailed temporary password is confined.
     *
     * Checked before role, permission and project, because it outranks all three: it
     * does not matter that the account is an Admin if the credential that opened it
     * arrived in a mailbox and has not been replaced yet. Only routes that explicitly
     * opt in - reading your own identity, changing the password, signing out - run.
     *
     * This is what makes the restriction real rather than cosmetic. A user who skips
     * the React redirect and calls the API directly arrives here, and is refused.
     */
    if (user.mustChangePassword) {
      const exempt = this.reflector.getAllAndOverride<boolean>(
        PASSWORD_CHANGE_EXEMPT,
        [context.getHandler(), context.getClass()],
      );
      if (!exempt) return this.deny(request, 'password-change', 'pending');
    }

    const roles = this.reflector.getAllAndOverride<readonly Role[]>(
      REQUIRED_ROLES,
      [context.getHandler(), context.getClass()],
    );
    if (roles?.length && !hasRole(user, ...roles))
      return this.deny(request, 'role', roles.join(','));

    const permission = this.reflector.getAllAndOverride<Permission>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (permission && !hasPermission(user, permission))
      return this.deny(request, 'permission', permission);

    const source = this.reflector.getAllAndOverride<ProjectSource>(
      PROJECT_SOURCE,
      [context.getHandler(), context.getClass()],
    );
    if (source) {
      const projectId = readProjectId(request, source);
      // A route declared project-scoped that was reached without naming a project is a
      // wiring mistake; refusing is the safe reading of it.
      if (!projectId || !hasProjectAccess(user, projectId))
        return this.deny(request, 'project', projectId ?? '(missing)');
    }

    return true;
  }

  /** Every refusal is recorded: an unauthorized attempt is itself security signal. */
  private async deny(
    request: RequestWithUser,
    check: string,
    detail: string,
  ): Promise<never> {
    await this.audit.record({
      user: request.user,
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      resourceType: check === 'project' ? 'project' : 'route',
      resourceId: check === 'project' ? detail : (request.originalUrl ?? request.url ?? null),
      outcome: 'denied',
      request,
      metadata: {
        check,
        required: detail,
        method: request.method ?? null,
        path: request.originalUrl ?? request.url ?? null,
        role: request.user?.role ?? null,
      },
    });
    throw new ForbiddenException(
      check === 'project'
        ? 'You do not have access to this project'
        : check === 'password-change'
          ? 'You must change your temporary password before continuing'
          : 'Your role does not permit this action',
    );
  }
}

function readProjectId(
  request: RequestWithUser,
  source: ProjectSource,
): string | undefined {
  const container =
    source.in === 'param'
      ? request.params
      : source.in === 'query'
        ? request.query
        : request.body;
  const value = (container as Record<string, unknown> | undefined)?.[source.name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  PROJECT_ASSIGNMENT_REPOSITORY,
  USER_REPOSITORY,
  isRole,
  readCookie,
  readBearerToken,
  verifyAccessToken,
  type AuthenticatedUser,
  type ProjectAssignmentRepository,
  type TokenSettings,
  type UserRepository,
} from '@faultline/auth';
import { IS_PUBLIC, type RequestWithUser } from './context';
import { AuthSecurityStore } from './security-store';
import { SESSION_COOKIE } from './session-cookie';

/**
 * Establishes who is calling, for every request.
 *
 * Registered globally, so a route is authenticated unless it is explicitly marked
 * `@Public()`. That direction matters: a new controller added later is protected by
 * default, and forgetting a decorator locks a route down rather than opening it.
 *
 * The identity is rebuilt from storage on every request rather than trusted from the
 * token. The Redis session is checked for revocation, then the current user and project
 * assignments are reloaded so authorization follows current state, not login-time state.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  private readonly tokens: TokenSettings;

  constructor(
    private readonly reflector: Reflector,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PROJECT_ASSIGNMENT_REPOSITORY)
    private readonly assignments: ProjectAssignmentRepository,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
    private readonly security: AuthSecurityStore,
  ) {
    this.tokens = {
      secret: config.auth.jwtSecret ?? '',
      issuer: config.auth.issuer,
      ttlSeconds: config.auth.accessTokenTtlSeconds,
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const cookieHeader = Array.isArray(request.headers.cookie)
      ? request.headers.cookie[0]
      : request.headers.cookie;
    const token =
      readBearerToken(request.headers.authorization) ??
      readCookie(cookieHeader, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('Authentication required');

    let subject: string;
    let sessionId: string;
    try {
      const claims = verifyAccessToken(token, this.tokens);
      subject = claims.sub;
      sessionId = claims.jti;
    } catch {
      // The reason is deliberately not echoed: distinguishing "expired" from "bad
      // signature" to an unauthenticated caller is free information.
      throw new UnauthorizedException('Invalid or expired credentials');
    }

    if (!(await this.security.isSessionActive(sessionId, subject)))
      throw new UnauthorizedException('Invalid or expired credentials');

    const user = await this.users.findById(subject);
    if (!user || user.status !== 'active' || !isRole(user.role))
      throw new UnauthorizedException('Invalid or expired credentials');

    const authenticated: AuthenticatedUser = {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      // Read from storage, never from the token: the whole point is that it flips to
      // false the moment the password is changed, without re-issuing anything.
      mustChangePassword: user.mustChangePassword,
      assignments: await this.assignments.listForUser(user.id),
    };
    request.user = authenticated;
    request.sessionId = sessionId;
    return true;
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  AUDIT_ACTIONS,
  PROJECT_ASSIGNMENT_REPOSITORY,
  USER_REPOSITORY,
  isRole,
  issueAccessToken,
  presentUser,
  verifyPassword,
  type AuthenticatedUser,
  type ProjectAssignmentRepository,
  type TokenSettings,
  type UserRepository,
} from '@faultline/auth';
import { AuditTrail } from './audit-trail';
import { CurrentUser, Public, type RequestWithUser } from './context';

/**
 * Throttles credential guessing.
 *
 * In-process and therefore per-instance: it raises the cost of an online guessing
 * attack against a single API pod, and is not a substitute for a shared rate limiter at
 * the edge when the API is scaled out. Recorded here rather than left implicit because
 * the limitation matters to whoever deploys it.
 */
@Injectable()
export class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private static readonly MAX_ATTEMPTS = 8;
  private static readonly WINDOW_MS = 15 * 60 * 1000;

  check(key: string, now = Date.now()): void {
    const entry = this.attempts.get(key);
    if (entry && entry.until > now && entry.count >= LoginThrottle.MAX_ATTEMPTS)
      throw new UnauthorizedException(
        'Too many failed attempts; try again later',
      );
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.attempts.get(key);
    if (!entry || entry.until <= now)
      this.attempts.set(key, { count: 1, until: now + LoginThrottle.WINDOW_MS });
    else entry.count += 1;
    // Bounded so a flood of distinct keys cannot grow this without limit.
    if (this.attempts.size > 10_000) this.attempts.clear();
  }

  succeed(key: string): void {
    this.attempts.delete(key);
  }
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

/**
 * Local credential login.
 *
 * This is the identity source of record today. The shape it returns - an access token
 * plus the user's role and project ids - is what an SSO, OAuth or LDAP integration
 * would return too, so adding one means adding a route that ends in the same
 * `issue()` call rather than reworking the client.
 */
@Controller('auth')
export class AuthController {
  private readonly tokens: TokenSettings;
  private readonly mfaRequired: boolean;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PROJECT_ASSIGNMENT_REPOSITORY)
    private readonly assignments: ProjectAssignmentRepository,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
    private readonly audit: AuditTrail,
    private readonly throttle: LoginThrottle,
  ) {
    this.tokens = {
      secret: config.auth.jwtSecret ?? '',
      issuer: config.auth.issuer,
      ttlSeconds: config.auth.accessTokenTtlSeconds,
    };
    this.mfaRequired = config.auth.mfaRequired;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(@Body() body: LoginBody, @Req() request: RequestWithUser) {
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password)
      throw new BadRequestException('Email and password are required');

    const throttleKey = email.toLowerCase();
    this.throttle.check(throttleKey);

    const user = await this.users.findByEmail(email);
    // Verified even when the user is unknown, against a hash that cannot match, so a
    // missing account and a wrong password take the same time to answer.
    const correct = await verifyPassword(password, user?.passwordHash ?? null);

    if (!user || !correct || user.status !== 'active' || !isRole(user.role)) {
      this.throttle.fail(throttleKey);
      await this.audit.record({
        userId: user?.id ?? null,
        actor: email,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        resourceType: 'session',
        outcome: 'denied',
        request,
        metadata: {
          reason: !user
            ? 'unknown_user'
            : user.status !== 'active'
              ? 'disabled'
              : 'bad_password',
        },
      });
      // One message for every failure mode: which of them it was is information an
      // attacker would otherwise get for free.
      throw new UnauthorizedException('Invalid email or password');
    }

    this.throttle.succeed(throttleKey);

    if (this.mfaRequired && user.mfaEnabled) {
      await this.audit.record({
        userId: user.id,
        actor: user.email,
        action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
        resourceType: 'session',
        resourceId: user.id,
        request,
        metadata: { stage: 'password', mfaPending: true },
      });
      // No token is issued here. The second factor is not implemented in this
      // deployment; the flag tells the client to collect one and tells an operator
      // that an MFA provider must be wired before turning AUTH_MFA_REQUIRED on.
      throw new ServiceUnavailableException(
        'A second factor is required but no MFA provider is configured',
      );
    }

    const assignments = await this.assignments.listForUser(user.id);
    const authenticated: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      assignments,
    };
    const { token, expiresAt } = issueAccessToken(
      { sub: user.id, email: user.email, role: user.role },
      this.tokens,
    );

    await this.audit.record({
      user: authenticated,
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      resourceType: 'session',
      resourceId: user.id,
      request,
      metadata: { role: user.role, projects: assignments.length },
    });

    return { accessToken: token, expiresAt, user: presentUser(authenticated) };
  }

  /**
   * Ends a session.
   *
   * Tokens are self-contained and are not tracked server side, so this records the
   * event and the client discards the token. A deployment that needs immediate
   * server-side revocation adds a token denylist behind this route; disabling the user
   * already takes effect on the next request, because the guard re-reads them.
   */
  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithUser,
  ): Promise<void> {
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.LOGOUT,
      resourceType: 'session',
      resourceId: user.id,
      request,
    });
  }

  /** The identity behind the current token, re-read from storage by the guard. */
  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@CurrentUser() user: AuthenticatedUser) {
    return presentUser(user);
  }
}

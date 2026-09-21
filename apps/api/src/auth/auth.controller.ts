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
  TEMPORARY_PASSWORD_LENGTH,
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
import {
  AllowWhilePasswordChangePending,
  CurrentUser,
  Public,
  type RequestWithUser,
} from './context';

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
  /** An email address or a username; provisioned admins are given the latter. */
  email?: unknown;
  username?: unknown;
  password?: unknown;
}

interface ChangePasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
}

/**
 * The floor for a password someone chooses.
 *
 * Length rather than a character-class maze: a 12-character passphrase resists guessing
 * far better than `P@ssw0rd!`, and composition rules mostly teach people to put the
 * digit at the end. The generated temporary password satisfies this comfortably.
 */
const MINIMUM_PASSWORD_LENGTH = 12;

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
    const identifier =
      typeof body?.email === 'string' && body.email.trim()
        ? body.email.trim()
        : typeof body?.username === 'string'
          ? body.username.trim()
          : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!identifier || !password)
      throw new BadRequestException('Email or username, and password, are required');

    const throttleKey = identifier.toLowerCase();
    this.throttle.check(throttleKey);

    // A provisioned admin is emailed a username, while everyone else knows their email,
    // so one field accepts either. The lookup order does not leak anything: both
    // outcomes converge on the same failure below.
    const user = identifier.includes('@')
      ? await this.users.findByEmail(identifier)
      : ((await this.users.findByUsername(identifier)) ??
        (await this.users.findByEmail(identifier)));
    // Verified even when the user is unknown, against a hash that cannot match, so a
    // missing account and a wrong password take the same time to answer.
    const correct = await verifyPassword(password, user?.passwordHash ?? null);

    if (!user || !correct || user.status !== 'active' || !isRole(user.role)) {
      this.throttle.fail(throttleKey);
      await this.audit.record({
        userId: user?.id ?? null,
        actor: identifier,
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
      username: user.username,
      name: user.name,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      mustChangePassword: user.mustChangePassword,
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
      metadata: {
        role: user.role,
        projects: assignments.length,
        mustChangePassword: user.mustChangePassword,
      },
    });

    // The token is issued either way. It is a real session - it just cannot reach
    // anything except the password change while `mustChangePassword` stands, which the
    // authorization guard enforces on every request rather than trusting this flag.
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
  @AllowWhilePasswordChangePending()
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
  @AllowWhilePasswordChangePending()
  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@CurrentUser() user: AuthenticatedUser) {
    return presentUser(user);
  }

  /**
   * Replaces the caller's own password, and with it their confinement.
   *
   * Reachable while `mustChangePassword` stands - it is the way out of that state - and
   * afterwards too, so an admin who simply wants a new password uses the same route.
   *
   * The current password is required even though the caller is already authenticated.
   * A token alone is not proof of knowing the password: it may have been lifted from a
   * browser, and without this check the theft would become permanent ownership.
   */
  @AllowWhilePasswordChangePending()
  @Post('change-password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChangePasswordBody,
    @Req() request: RequestWithUser,
  ) {
    const currentPassword =
      typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword =
      typeof body?.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || !newPassword)
      throw new BadRequestException(
        'Current and new passwords are both required',
      );
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH)
      throw new BadRequestException(
        `New password must be at least ${MINIMUM_PASSWORD_LENGTH} characters`,
      );
    if (newPassword === currentPassword)
      throw new BadRequestException(
        'New password must be different from the current one',
      );

    const stored = await this.users.findById(user.id);
    if (!stored) throw new UnauthorizedException('Invalid or expired credentials');

    if (!(await verifyPassword(currentPassword, stored.passwordHash ?? null))) {
      // Throttled on the user id: this is a second place a password can be guessed,
      // and leaving it unmetered would make the confinement screen the soft target.
      this.throttle.fail(`change:${user.id}`);
      await this.audit.record({
        user,
        action: AUDIT_ACTIONS.USER_MODIFIED,
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'denied',
        request,
        metadata: { field: 'password', reason: 'wrong_current_password' },
      });
      throw new UnauthorizedException('Current password is incorrect');
    }
    this.throttle.check(`change:${user.id}`);

    // One write: the hash replaces the temporary one and the confinement lifts
    // together, so there is no moment where the old password still opens the account
    // or the new one is refused.
    const updated = await this.users.update(user.id, {
      password: newPassword,
      mustChangePassword: false,
    });
    if (!updated)
      throw new UnauthorizedException('Invalid or expired credentials');

    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      resourceType: 'user',
      resourceId: user.id,
      request,
      metadata: {
        // Worth distinguishing in the trail: the first is the end of provisioning,
        // the second is routine hygiene.
        temporary: user.mustChangePassword,
      },
    });

    const refreshed: AuthenticatedUser = {
      ...user,
      mustChangePassword: false,
    };
    // A fresh token, so the client is not left holding one minted before the change.
    // The previous token is not invalidated - it belongs to the same user, and the
    // guard reads `mustChangePassword` from storage, so it is no longer confined
    // either. Bounded by the token TTL; see docs/SUBSCRIPTIONS.md.
    const { token, expiresAt } = issueAccessToken(
      { sub: user.id, email: user.email, role: user.role },
      this.tokens,
    );
    return {
      accessToken: token,
      expiresAt,
      user: presentUser(refreshed),
      minimumPasswordLength: MINIMUM_PASSWORD_LENGTH,
      temporaryPasswordLength: TEMPORARY_PASSWORD_LENGTH,
    };
  }
}

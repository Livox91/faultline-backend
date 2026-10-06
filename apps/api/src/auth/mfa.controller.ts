import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
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
  authenticatorUri,
  currentTotpCounter,
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  issueAccessToken,
  issueMfaEnrollmentToken,
  issueMfaTrustedDeviceToken,
  presentUser,
  recoveryCodeMatches,
  verifyMfaChallengeToken,
  verifyMfaEnrollmentToken,
  verifyPassword,
  verifyTotp,
  type AuthenticatedUser,
  type ProjectAssignmentRepository,
  type TokenSettings,
  type UserRecord,
  type UserRepository,
} from '@faultline/auth';
import { AuditTrail } from './audit-trail';
import { LoginThrottle } from './auth.controller';
import { AuthSecurityStore } from './security-store';
import {
  setMfaTrustedDeviceCookie,
  setSessionCookie,
  type CookieResponse,
} from './session-cookie';
import {
  AllowWhileMfaEnrollmentPending,
  CurrentUser,
  Public,
  type RequestWithUser,
} from './context';

type MfaBody = {
  currentPassword?: unknown;
  code?: unknown;
  challengeToken?: unknown;
  enrollmentToken?: unknown;
  rememberDevice?: unknown;
};

@Controller('auth/mfa')
export class MfaController {
  private readonly tokens: TokenSettings;
  private readonly masterSecret: string;
  private readonly issuer: string;
  private readonly required: boolean;
  private readonly secureCookies: boolean;
  private readonly trustedDeviceTtlDays: number;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PROJECT_ASSIGNMENT_REPOSITORY)
    private readonly assignments: ProjectAssignmentRepository,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
    private readonly audit: AuditTrail,
    private readonly throttle: LoginThrottle,
    private readonly security: AuthSecurityStore,
  ) {
    this.masterSecret = config.auth.mfaEncryptionKey ?? config.auth.jwtSecret ?? '';
    this.issuer = config.applicationName;
    this.required = config.auth.mfaRequired;
    this.secureCookies = config.environment === 'production';
    this.trustedDeviceTtlDays = config.auth.mfaTrustedDeviceTtlDays ?? 30;
    this.tokens = {
      // MFA challenge/enrollment material is protected with the dedicated MFA key,
      // but the completed login must issue an ordinary access token. Every other
      // access token is signed with AUTH_JWT_SECRET and AuthenticationGuard verifies
      // only that key.
      secret: config.auth.jwtSecret ?? '',
      issuer: config.auth.issuer,
      ttlSeconds: config.auth.accessTokenTtlSeconds,
    };
  }

  @Public()
  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async verifyLogin(
    @Body() body: MfaBody,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const challengeToken = requiredText(body?.challengeToken, 'MFA challenge token');
    const code = requiredText(body?.code, 'Authenticator or recovery code');
    if (body?.rememberDevice !== undefined && typeof body.rememberDevice !== 'boolean')
      throw new BadRequestException('rememberDevice must be a boolean');
    let challenge: ReturnType<typeof verifyMfaChallengeToken>;
    try {
      challenge = verifyMfaChallengeToken(challengeToken, this.masterSecret);
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA challenge');
    }

    const throttleKey = `mfa:${challenge.userId}`;
    await this.throttle.check(throttleKey);
    const user = await this.users.findById(challenge.userId);
    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecretCiphertext)
      throw new UnauthorizedException('Invalid or expired MFA challenge');

    const factor = await this.verifyAndConsumeFactor(user, code);
    if (!factor) {
      await this.throttle.fail(throttleKey);
      await this.audit.record({
        userId: user.id,
        organizationId: user.organizationId,
        actor: user.email,
        action: AUDIT_ACTIONS.MFA_CHALLENGE_FAILED,
        resourceType: 'session',
        resourceId: user.id,
        outcome: 'denied',
        request,
        metadata: { reason: 'invalid_code' },
      });
      throw new UnauthorizedException('Invalid authenticator or recovery code');
    }

    if (!(await this.users.consumeMfaChallenge(challenge.challengeId, user.id)))
      throw new UnauthorizedException('Invalid or expired MFA challenge');
    await this.throttle.succeed(throttleKey);

    const assignments = await this.assignments.listForUser(user.id);
    const authenticated = this.authenticated(user, assignments);
    const { token, expiresAt, sessionId } = issueAccessToken(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        amr: ['pwd', factor.kind === 'totp' ? 'otp' : 'recovery'],
        sv: user.sessionVersion,
      },
      this.tokens,
    );
    await this.security.createSession(sessionId, user.id, this.tokens.ttlSeconds);
    setSessionCookie(response, token, this.tokens.ttlSeconds, this.secureCookies);
    if (body.rememberDevice) {
      const trustedDevice = issueMfaTrustedDeviceToken(
        user.id,
        user.mfaSecretCiphertext,
        user.sessionVersion,
        this.masterSecret,
        this.trustedDeviceTtlDays,
      );
      setMfaTrustedDeviceCookie(
        response,
        trustedDevice.token,
        this.trustedDeviceTtlDays * 24 * 60 * 60,
        this.secureCookies,
      );
    }
    await this.audit.record({
      user: authenticated,
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      resourceType: 'session',
      resourceId: user.id,
      request,
      metadata: {
        role: user.role,
        projects: assignments.length,
        mfa: factor.kind,
        rememberedDevice: body.rememberDevice === true,
        recoveryCodesRemaining:
          factor.kind === 'recovery' ? user.mfaRecoveryCodeHashes.length - 1 : undefined,
      },
    });
    return { accessToken: token, expiresAt, user: presentUser(authenticated) };
  }

  @Get('status')
  @AllowWhileMfaEnrollmentPending()
  @Header('Cache-Control', 'no-store')
  async status(@CurrentUser() user: AuthenticatedUser) {
    const stored = await this.requireUser(user.id);
    return {
      enabled: stored.mfaEnabled && !!stored.mfaSecretCiphertext,
      required: this.required,
      recoveryCodesRemaining: stored.mfaRecoveryCodeHashes.length,
    };
  }

  @Post('enrollment/start')
  @AllowWhileMfaEnrollmentPending()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async startEnrollment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MfaBody,
    @Req() request: RequestWithUser,
  ) {
    const currentPassword = requiredText(body?.currentPassword, 'Current password');
    const stored = await this.requireUser(user.id);
    await this.requirePassword(stored, currentPassword, `mfa-enroll:${user.id}`);

    const secret = generateMfaSecret();
    const encryptedSecret = encryptMfaSecret(secret, this.masterSecret);
    const challengeExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const challengeId = await this.users.createMfaChallenge(user.id, challengeExpiresAt);
    const enrollment = issueMfaEnrollmentToken(
      user.id,
      encryptedSecret,
      challengeId,
      this.masterSecret,
    );
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.MFA_ENROLLMENT_STARTED,
      resourceType: 'user',
      resourceId: user.id,
      request,
    });
    return {
      secret,
      authenticatorUri: authenticatorUri({ secret, issuer: this.issuer, account: user.email }),
      enrollmentToken: enrollment.token,
      expiresAt: enrollment.expiresAt,
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
    };
  }

  @Post('enrollment/verify')
  @AllowWhileMfaEnrollmentPending()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async finishEnrollment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MfaBody,
    @Req() request: RequestWithUser,
  ) {
    const enrollmentToken = requiredText(body?.enrollmentToken, 'MFA enrollment token');
    const code = requiredText(body?.code, 'Authenticator code');
    let enrollment: ReturnType<typeof verifyMfaEnrollmentToken>;
    try {
      enrollment = verifyMfaEnrollmentToken(enrollmentToken, this.masterSecret);
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA enrollment');
    }
    if (enrollment.userId !== user.id)
      throw new UnauthorizedException('Invalid or expired MFA enrollment');
    const secret = decryptMfaSecret(enrollment.encryptedSecret, this.masterSecret);
    const counter = verifyTotp(secret, code);
    if (counter === undefined)
      throw new UnauthorizedException('Invalid authenticator code');
    if (!(await this.users.consumeMfaChallenge(enrollment.challengeId, user.id)))
      throw new UnauthorizedException('Invalid or expired MFA enrollment');

    const recoveryCodes = generateRecoveryCodes();
    const hashes = recoveryCodes.map((value) => hashRecoveryCode(value, this.masterSecret));
    const updated = await this.users.configureMfa(
      user.id,
      enrollment.encryptedSecret,
      hashes,
      counter,
    );
    if (!updated) throw new UnauthorizedException('Invalid or expired credentials');
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.MFA_ENABLED,
      resourceType: 'user',
      resourceId: user.id,
      request,
      metadata: { recoveryCodes: recoveryCodes.length },
    });
    return { enabled: true, recoveryCodes };
  }

  @Post('disable')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MfaBody,
    @Req() request: RequestWithUser,
  ) {
    if (this.required)
      throw new ForbiddenException('MFA is required by this deployment and cannot be disabled');
    const currentPassword = requiredText(body?.currentPassword, 'Current password');
    const code = requiredText(body?.code, 'Authenticator or recovery code');
    const stored = await this.requireUser(user.id);
    await this.requirePassword(stored, currentPassword, `mfa-disable:${user.id}`);
    if (!stored.mfaEnabled || !(await this.verifyAndConsumeFactor(stored, code)))
      throw new UnauthorizedException('Invalid authenticator or recovery code');
    await this.users.disableMfa(user.id);
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.MFA_DISABLED,
      resourceType: 'user',
      resourceId: user.id,
      request,
    });
    return { enabled: false };
  }

  @Post('recovery-codes/regenerate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MfaBody,
    @Req() request: RequestWithUser,
  ) {
    const currentPassword = requiredText(body?.currentPassword, 'Current password');
    const code = requiredText(body?.code, 'Authenticator or recovery code');
    const stored = await this.requireUser(user.id);
    await this.requirePassword(stored, currentPassword, `mfa-recovery:${user.id}`);
    const factor = await this.verifyAndConsumeFactor(stored, code);
    if (!stored.mfaEnabled || !stored.mfaSecretCiphertext || !factor)
      throw new UnauthorizedException('Invalid authenticator or recovery code');
    const recoveryCodes = generateRecoveryCodes();
    await this.users.configureMfa(
      user.id,
      stored.mfaSecretCiphertext,
      recoveryCodes.map((value) => hashRecoveryCode(value, this.masterSecret)),
      factor.kind === 'totp'
        ? factor.counter
        : (stored.mfaLastUsedCounter ?? currentTotpCounter() - 2),
    );
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.MFA_RECOVERY_CODES_REGENERATED,
      resourceType: 'user',
      resourceId: user.id,
      request,
      metadata: { recoveryCodes: recoveryCodes.length },
    });
    return { recoveryCodes };
  }

  private async requireUser(id: string): Promise<UserRecord> {
    const user = await this.users.findById(id);
    if (!user || user.status !== 'active')
      throw new UnauthorizedException('Invalid or expired credentials');
    return user;
  }

  private async requirePassword(user: UserRecord, password: string, throttleKey: string) {
    await this.throttle.check(throttleKey);
    if (!(await verifyPassword(password, user.passwordHash ?? null))) {
      await this.throttle.fail(throttleKey);
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.throttle.succeed(throttleKey);
  }

  private async verifyAndConsumeFactor(
    user: UserRecord,
    code: string,
  ): Promise<{ kind: 'totp'; counter: number } | { kind: 'recovery' } | undefined> {
    if (!user.mfaSecretCiphertext) return undefined;
    const secret = decryptMfaSecret(user.mfaSecretCiphertext, this.masterSecret);
    const counter = verifyTotp(secret, code);
    if (counter !== undefined) {
      if (!(await this.users.consumeMfaTotpCounter(user.id, counter))) return undefined;
      return { kind: 'totp', counter };
    }
    const recoveryHash = recoveryCodeMatches(
      code,
      user.mfaRecoveryCodeHashes,
      this.masterSecret,
    );
    if (!recoveryHash || !(await this.users.consumeMfaRecoveryCode(user.id, recoveryHash)))
      return undefined;
    return { kind: 'recovery' };
  }

  private authenticated(
    user: UserRecord,
    assignments: Awaited<ReturnType<ProjectAssignmentRepository['listForUser']>>,
  ): AuthenticatedUser {
    return {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
      status: user.status,
      mfaEnabled: true,
      mfaEnrollmentRequired: false,
      mustChangePassword: user.mustChangePassword,
      assignments,
    };
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${label} is required`);
  return value.trim();
}

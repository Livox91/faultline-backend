import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { APPLICATION_CONFIG, type ApplicationConfig } from '@faultline/platform';
import {
  AUDIT_ACTIONS,
  PasswordReuseError,
  USER_REPOSITORY,
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordPolicyError,
  type UserRepository,
} from '@faultline/auth';
import {
  EMAIL_SENDER,
  passwordResetEmail,
  type EmailSender,
} from '@faultline/email';
import { AuditTrail } from './audit-trail';
import { Public, clientAddress, type RequestWithUser } from './context';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type ForgotPasswordBody = { email?: unknown };
type ResetPasswordBody = { token?: unknown; newPassword?: unknown };

@Injectable()
export class PasswordResetThrottle {
  private readonly attempts = new Map<string, { count: number; until: number }>();

  take(key: string, limit: number, now = Date.now()): void {
    const existing = this.attempts.get(key);
    if (!existing || existing.until <= now) {
      this.attempts.set(key, { count: 1, until: now + 15 * 60 * 1000 });
    } else {
      if (existing.count >= limit)
        throw new HttpException('Too many password reset requests; try again later', HttpStatus.TOO_MANY_REQUESTS);
      existing.count += 1;
    }
    if (this.attempts.size > 10_000) this.attempts.clear();
  }
}

@Controller('auth')
export class PasswordResetController {
  private readonly publicUrl: string;
  private readonly applicationName: string;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
    private readonly audit: AuditTrail,
    private readonly throttle: PasswordResetThrottle,
  ) {
    this.publicUrl = config.publicUrl;
    this.applicationName = config.applicationName;
    this.ttlSeconds = config.auth.passwordResetTtlSeconds;
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async forgotPassword(
    @Body() body: ForgotPasswordBody,
    @Req() request: RequestWithUser,
  ) {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(email)) throw new BadRequestException('A valid email address is required');

    this.throttle.take(`email:${email}`, 5);
    this.throttle.take(`ip:${clientAddress(request) ?? 'unknown'}`, 20);
    const user = await this.users.findByEmail(email);
    if (user?.status === 'active' && user.passwordHash) {
      const token = generatePasswordResetToken();
      const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
      await this.users.createPasswordResetToken(
        user.id,
        hashPasswordResetToken(token),
        expiresAt,
      );
      try {
        await this.email.send(
          passwordResetEmail({
            applicationName: this.applicationName,
            to: user.email,
            resetUrl: `${this.publicUrl}/reset-password?token=${encodeURIComponent(token)}`,
            expiresInMinutes: Math.ceil(this.ttlSeconds / 60),
          }),
        );
        await this.audit.record({
          userId: user.id,
          organizationId: user.organizationId,
          actor: user.email,
          action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
          resourceType: 'user',
          resourceId: user.id,
          request,
        });
      } catch {
        // The response remains indistinguishable from an unknown address. Operational
        // monitoring gets the failure without turning email existence into an oracle.
        await this.audit.record({
          userId: user.id,
          organizationId: user.organizationId,
          actor: user.email,
          action: AUDIT_ACTIONS.PASSWORD_RESET_FAILED,
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'denied',
          request,
          metadata: { reason: 'delivery_failed' },
        });
      }
    }

    return {
      message: 'If an active account exists for that email, a password reset link has been sent.',
    };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async resetPassword(
    @Body() body: ResetPasswordBody,
    @Req() request: RequestWithUser,
  ) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    if (!token) throw new BadRequestException('Password reset token is required');
    const policyError = passwordPolicyError(newPassword);
    if (policyError) throw new BadRequestException(policyError);

    let updated;
    try {
      updated = await this.users.resetPasswordWithToken(
        hashPasswordResetToken(token),
        newPassword,
      );
    } catch (error) {
      if (error instanceof PasswordReuseError)
        throw new BadRequestException(error.message);
      throw error;
    }
    if (!updated) {
      await this.audit.record({
        actor: 'password-reset',
        action: AUDIT_ACTIONS.PASSWORD_RESET_FAILED,
        resourceType: 'session',
        outcome: 'denied',
        request,
        metadata: { reason: 'invalid_or_expired_token' },
      });
      throw new UnauthorizedException('This password reset link is invalid or has expired');
    }

    await this.audit.record({
      userId: updated.id,
      organizationId: updated.organizationId,
      actor: updated.email,
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      resourceType: 'user',
      resourceId: updated.id,
      request,
    });
    return { message: 'Password reset successfully. You can now sign in.' };
  }
}

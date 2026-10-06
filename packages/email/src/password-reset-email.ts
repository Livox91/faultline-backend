import type { EmailMessage } from './sender';

export interface PasswordResetEmailInput {
  readonly applicationName: string;
  readonly to: string;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function passwordResetEmail(input: PasswordResetEmailInput): EmailMessage {
  const text = [
    `Reset your ${input.applicationName} password`,
    '',
    'A password reset was requested for your account.',
    '',
    `Reset password: ${input.resetUrl}`,
    '',
    `This link expires in ${input.expiresInMinutes} minutes and can be used only once.`,
    'If you did not request this, you can ignore this email. Your password has not changed.',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;">
    <tr><td style="padding:28px;">
      <h1 style="margin:0 0 12px;font-size:20px;">Reset your ${escapeHtml(input.applicationName)} password</h1>
      <p style="font-size:14px;color:#4b5563;line-height:1.5;">A password reset was requested for your account.</p>
      <p style="margin:22px 0;"><a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:8px;">Reset password</a></p>
      <p style="font-size:13px;color:#6b7280;line-height:1.5;">This link expires in ${input.expiresInMinutes} minutes and can be used only once.</p>
      <p style="font-size:12px;color:#9ca3af;line-height:1.5;">If you did not request this, ignore this email. Your password has not changed.</p>
    </td></tr>
  </table>
</body></html>`;

  return {
    to: input.to,
    subject: `Reset your ${input.applicationName} password`,
    text,
    html,
  };
}

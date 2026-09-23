import type { EmailMessage } from './sender';

export interface CredentialsEmailInput {
  readonly applicationName: string;
  readonly to: string;
  readonly username: string;
  readonly temporaryPassword: string;
  readonly loginUrl: string;
  readonly planName: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * The one email that carries a credential.
 *
 * The temporary password appears here and nowhere else: not in an API response, not in
 * a log line, and not in the database, which only ever holds its hash. That makes this
 * message the single point where the plaintext exists, which is why it says plainly
 * that it must be changed at first sign-in - the account is locked to the password
 * change screen until it is.
 */
export function credentialsEmail(input: CredentialsEmailInput): EmailMessage {
  const text = [
    `Welcome to ${input.applicationName}`,
    '',
    `Your ${input.planName} subscription has been successfully activated.`,
    '',
    'Your account credentials:',
    '',
    `  Username: ${input.username}`,
    `  Temporary Password: ${input.temporaryPassword}`,
    '',
    'Login:',
    `  ${input.loginUrl}`,
    '',
    'IMPORTANT:',
    'You must change your temporary password when you first log in. Until you do,',
    'the account can reach nothing but the password change screen.',
    '',
    'If you did not purchase this subscription, reply to this email immediately.',
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
      <tr><td style="padding:28px;">
        <h1 style="margin:0 0 4px;font-size:20px;">Welcome to ${escapeHtml(input.applicationName)}</h1>
        <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">
          Your ${escapeHtml(input.planName)} subscription has been successfully activated.
        </p>

        <p style="margin:0 0 8px;font-size:14px;font-weight:600;">Your account credentials</p>
        <table role="presentation" style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:0;">
          <tr><td style="padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;">
            <div style="margin-bottom:6px;"><span style="color:#6b7280;">Username:</span> <strong>${escapeHtml(input.username)}</strong></div>
            <div><span style="color:#6b7280;">Temporary Password:</span> <strong>${escapeHtml(input.temporaryPassword)}</strong></div>
          </td></tr>
        </table>

        <p style="margin:20px 0;">
          <a href="${escapeHtml(input.loginUrl)}"
             style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;">
            Sign in
          </a>
        </p>

        <p style="margin:0;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#991b1b;font-size:13px;line-height:1.5;">
          <strong>Important:</strong> you must change this temporary password when you first
          sign in. Until you do, the account can reach nothing but the password change screen.
        </p>

        <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;">
          If you did not purchase this subscription, reply to this email immediately.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  return {
    to: input.to,
    subject: `Your ${input.applicationName} admin account`,
    text,
    html,
  };
}

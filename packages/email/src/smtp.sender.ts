import { createTransport, type Transporter } from 'nodemailer';
import { EmailDeliveryError, type EmailMessage, type EmailSender } from './sender';

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS (port 465). STARTTLS on 587 is negotiated automatically. */
  readonly secure: boolean;
  readonly username?: string;
  readonly password?: string;
  /** The From header, e.g. `Faultline <no-reply@example.com>`. */
  readonly from: string;
}

/**
 * SMTP delivery.
 *
 * Deliberately the only transport that talks to the outside world, and it is
 * constructed from validated configuration rather than reading the environment itself,
 * so there is one place where mail credentials enter the process.
 *
 * Failures are raised, not swallowed: the caller decides what a failed credentials
 * email means. For provisioning it means the subscription is recorded as paid with
 * delivery outstanding, which is recoverable, rather than a payment that vanished.
 */
export class SmtpEmailSender implements EmailSender {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(private readonly settings: SmtpSettings) {
    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      ...(settings.username
        ? {
            auth: {
              user: settings.username,
              pass: settings.password ?? '',
            },
          }
        : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
    } catch (cause) {
      // The recipient is worth knowing; the body is not, because it may hold the
      // temporary password and this message goes to the log.
      throw new EmailDeliveryError(
        `SMTP delivery to ${message.to} failed`,
        cause,
      );
    }
  }
}

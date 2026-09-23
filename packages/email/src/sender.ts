/**
 * Outbound email, behind one interface.
 *
 * The platform has never sent email, so rather than wiring a provider into the one
 * place that needs it, this is the seam: SMTP today, and SendGrid, Resend or SES later
 * by adding a class here. Nothing that composes a message knows how it leaves.
 *
 * No credential appears in this package. Transports are constructed from configuration
 * the platform validated, which comes from the environment.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** Always present; the fallback when a client will not render HTML. */
  readonly text: string;
  readonly html?: string;
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol('faultline.email-sender');

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/**
 * Development and test transport.
 *
 * Records what would have been sent and, optionally, prints it. A temporary password is
 * only useful to whoever receives it, so in development the log is how you receive it -
 * but this never runs in production: configuration validation requires real SMTP
 * settings there, so a deployment cannot silently swallow credential emails.
 */
export class RecordingEmailSender implements EmailSender {
  readonly name = 'recording';
  readonly sent: EmailMessage[] = [];

  constructor(private readonly log?: (message: EmailMessage) => void) {}

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    this.log?.(message);
  }

  /** Test helper: the most recent message addressed to someone. */
  lastTo(recipient: string): EmailMessage | undefined {
    return [...this.sent]
      .reverse()
      .find((message) => message.to.toLowerCase() === recipient.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}

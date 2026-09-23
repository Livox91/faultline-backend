import { Inject, Injectable } from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  AUDIT_ACTIONS,
  DuplicateEmailError,
  ROLES,
  USER_REPOSITORY,
  allocateUsername,
  generateTemporaryPassword,
  isValidUsername,
  type UserRecord,
  type UserRepository,
} from '@faultline/auth';
import {
  EMAIL_SENDER,
  credentialsEmail,
  type EmailSender,
} from '@faultline/email';
import {
  PLANS,
  SUBSCRIPTION_REPOSITORY,
  type PlanId,
  type Subscription,
  type SubscriptionRepository,
  type SubscriptionStatus,
} from '@faultline/billing';
import { AuditTrail } from '../auth/audit-trail';

export interface ConfirmedPayment {
  readonly checkoutSessionId: string;
  readonly email: string;
  readonly plan: PlanId;
  readonly status: SubscriptionStatus;
  readonly customerId?: string | null;
  readonly subscriptionId?: string | null;
  /** What the purchaser typed on the subscription form, if anything. */
  readonly requestedUsername?: string | null;
  readonly fullName?: string | null;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}

export type ProvisioningOutcome =
  | { kind: 'provisioned'; subscription: Subscription; username: string }
  | { kind: 'already-provisioned'; subscription: Subscription }
  | { kind: 'linked-existing-user'; subscription: Subscription }
  | { kind: 'email-failed'; subscription: Subscription; username: string };

/**
 * Turns a confirmed payment into an Admin account, exactly once.
 *
 * Called only from the webhook handler, which has already verified the provider's
 * signature: nothing here trusts a browser's word that payment succeeded.
 *
 * Idempotency is enforced by the database rather than by checking-then-acting, at two
 * levels. The event id is claimed by the caller, which stops the *same* delivery being
 * processed twice. The `subscriptions.checkout_session_id` unique index collapses
 * different events about the same purchase onto one row. And the `users.email` unique
 * index is the final serialization point: if two runs somehow reach account creation
 * together, one insert loses, and the loser links to the winner's user rather than
 * failing or creating a second admin.
 */
@Injectable()
export class SubscriptionProvisioningService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly audit: AuditTrail,
    private readonly logger: ApplicationLogger,
  ) {}

  async provision(payment: ConfirmedPayment): Promise<ProvisioningOutcome> {
    // The row is written before any account exists. If everything after this throws,
    // the payment is still recorded and `listUnprovisioned` will surface it - a paid
    // customer with no account is a bug, but a paid customer with no *record* is
    // unrecoverable.
    const subscription = await this.subscriptions.createForCheckout({
      email: payment.email,
      paymentProvider: this.config.billing.provider,
      paymentProviderCustomerId: payment.customerId ?? null,
      paymentProviderSubscriptionId: payment.subscriptionId ?? null,
      checkoutSessionId: payment.checkoutSessionId,
      plan: payment.plan,
      status: payment.status,
      startDate: payment.startDate ?? null,
      endDate: payment.endDate ?? null,
    });

    await this.audit.record({
      actor: payment.email,
      action: AUDIT_ACTIONS.SUBSCRIPTION_PURCHASED,
      resourceType: 'subscription',
      resourceId: subscription.id,
      metadata: {
        plan: payment.plan,
        checkoutSessionId: payment.checkoutSessionId,
      },
    });

    if (subscription.provisioningStatus === 'provisioned')
      return { kind: 'already-provisioned', subscription };

    try {
      return await this.createOrLink(subscription, payment);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown failure';
      await this.subscriptions.update(subscription.id, {
        provisioningStatus: 'failed',
        provisioningError: reason,
      });
      await this.audit.record({
        actor: payment.email,
        action: AUDIT_ACTIONS.SUBSCRIPTION_PROVISIONING_FAILED,
        resourceType: 'subscription',
        resourceId: subscription.id,
        outcome: 'denied',
        metadata: { reason },
      });
      this.logger.error({
        event: 'subscription_provisioning_failed',
        subscription_id: subscription.id,
        reason,
      });
      // Rethrown so the webhook answers 5xx and the provider retries. The event claim
      // is released by the caller, so the retry is allowed to do real work.
      throw error;
    }
  }

  private async createOrLink(
    subscription: Subscription,
    payment: ConfirmedPayment,
  ): Promise<ProvisioningOutcome> {
    const existing = await this.users.findByEmail(payment.email);
    if (existing)
      return this.linkExistingUser(subscription, existing, payment);

    const username = await this.chooseUsername(payment);
    const temporaryPassword = generateTemporaryPassword();

    let created: UserRecord;
    try {
      created = await this.users.create({
        email: payment.email,
        username,
        name: payment.fullName?.trim() || payment.email.split('@')[0]!,
        role: ROLES.ADMIN,
        password: temporaryPassword,
        status: 'active',
        // The account is authenticated but confined until this is cleared: the
        // credential that opens it was emailed, and email is not a secure channel.
        mustChangePassword: true,
      });
    } catch (error) {
      // Lost the race with a concurrent delivery. The winner owns the account and has
      // already sent (or will send) the credentials, so this run must not email a
      // second temporary password - that would invalidate nothing but confuse everyone.
      if (error instanceof DuplicateEmailError) {
        const winner = await this.users.findByEmail(payment.email);
        if (winner) return this.linkExistingUser(subscription, winner, payment);
      }
      throw error;
    }

    const linked =
      (await this.subscriptions.update(subscription.id, {
        userId: created.id,
      })) ?? subscription;

    await this.audit.record({
      userId: created.id,
      actor: created.email,
      action: AUDIT_ACTIONS.USER_CREATED,
      resourceType: 'user',
      resourceId: created.id,
      metadata: {
        role: created.role,
        via: 'subscription',
        subscriptionId: subscription.id,
      },
    });

    // The plaintext exists only in this call and in the message it produces. It is not
    // returned to any caller, not logged, and not stored - the database has the hash.
    try {
      await this.email.send(
        credentialsEmail({
          applicationName: this.config.applicationName,
          to: created.email,
          username,
          temporaryPassword,
          loginUrl: `${this.config.publicUrl}/login`,
          planName: PLANS[payment.plan].name,
        }),
      );
    } catch (error) {
      // The account exists and the payment is recorded; only delivery failed. Marking
      // it rather than throwing keeps the successful purchase intact and lets the
      // reconciliation command re-issue credentials.
      const reason = error instanceof Error ? error.message : 'delivery failed';
      const marked =
        (await this.subscriptions.update(subscription.id, {
          provisioningStatus: 'email_failed',
          provisioningError: reason,
        })) ?? linked;
      this.logger.error({
        event: 'credentials_email_failed',
        subscription_id: subscription.id,
        reason,
      });
      return { kind: 'email-failed', subscription: marked, username };
    }

    const done =
      (await this.subscriptions.update(subscription.id, {
        provisioningStatus: 'provisioned',
        provisioningError: null,
      })) ?? linked;

    await this.audit.record({
      userId: created.id,
      actor: created.email,
      action: AUDIT_ACTIONS.SUBSCRIPTION_PROVISIONED,
      resourceType: 'subscription',
      resourceId: subscription.id,
      metadata: { userId: created.id, username, plan: payment.plan },
    });

    return { kind: 'provisioned', subscription: done, username };
  }

  /**
   * Attaches the subscription to an account that already exists.
   *
   * Deliberately does **not** change that account's role, password or confinement.
   * Promoting an existing Onsite Engineer to Admin because someone paid with their
   * email address would make the checkout form a privilege-escalation tool - anyone
   * could type a colleague's address, or their own, and buy themselves administration
   * over projects they were deliberately restricted from. The money is recorded and
   * linked; who someone is remains an administrative decision.
   */
  private async linkExistingUser(
    subscription: Subscription,
    user: UserRecord,
    payment: ConfirmedPayment,
  ): Promise<ProvisioningOutcome> {
    const linked =
      (await this.subscriptions.update(subscription.id, {
        userId: user.id,
        provisioningStatus: 'provisioned',
        provisioningError: null,
      })) ?? subscription;

    await this.audit.record({
      userId: user.id,
      actor: user.email,
      action: AUDIT_ACTIONS.SUBSCRIPTION_PROVISIONED,
      resourceType: 'subscription',
      resourceId: subscription.id,
      metadata: {
        linkedExistingUser: true,
        existingRole: user.role,
        roleChanged: false,
        plan: payment.plan,
      },
    });

    this.logger.log({
      event: 'subscription_linked_to_existing_user',
      subscription_id: subscription.id,
      // No new credentials were issued, and the role was left alone.
      role_unchanged: user.role,
    });

    return { kind: 'linked-existing-user', subscription: linked };
  }

  /**
   * Honours a requested username when it is valid and free, otherwise derives one.
   *
   * Falls back to the name, then the email local part, and appends a random suffix
   * until it finds a gap - never a sequential one, which would advertise how many
   * accounts exist.
   */
  private async chooseUsername(payment: ConfirmedPayment): Promise<string> {
    const isTaken = async (candidate: string) =>
      (await this.users.findByUsername(candidate)) !== undefined;

    const requested = payment.requestedUsername?.trim();
    if (requested && isValidUsername(requested) && !(await isTaken(requested)))
      return requested;

    return allocateUsername(
      requested || payment.fullName || payment.email.split('@')[0]!,
      isTaken,
    );
  }
}

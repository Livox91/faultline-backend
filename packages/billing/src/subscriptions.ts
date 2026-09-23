import type { PlanId } from './plans';

/**
 * Subscription state, kept separate from the user.
 *
 * A user is an identity; a subscription is a commercial relationship with its own
 * lifecycle, and the two do not change together. `userId` is nullable on purpose: the
 * row is written the moment payment is confirmed, *before* the admin account exists, so
 * that a payment can never be lost because provisioning failed a moment later.
 */
export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

/**
 * How far provisioning got.
 *
 * Separate from `status` because they answer different questions: `status` is what the
 * payment provider says about the money, `provisioningStatus` is what we managed to do
 * about it. A paid subscription whose credentials email bounced is
 * `active` / `email_failed` - visibly wrong, and retryable, rather than silently lost.
 */
export type ProvisioningStatus =
  | 'pending'
  | 'provisioned'
  | 'email_failed'
  | 'failed';

export interface Subscription {
  readonly id: string;
  /** Null until the admin account has been created. */
  readonly userId: string | null;
  readonly email: string;
  readonly paymentProvider: string;
  readonly paymentProviderCustomerId: string | null;
  readonly paymentProviderSubscriptionId: string | null;
  /** The checkout session that opened this subscription; unique, and an idempotency key. */
  readonly checkoutSessionId: string | null;
  readonly plan: PlanId;
  readonly status: SubscriptionStatus;
  readonly provisioningStatus: ProvisioningStatus;
  /** Why provisioning failed, for the operator reading the reconciliation report. */
  readonly provisioningError: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewSubscription {
  email: string;
  paymentProvider: string;
  paymentProviderCustomerId?: string | null;
  paymentProviderSubscriptionId?: string | null;
  checkoutSessionId?: string | null;
  plan: PlanId;
  status: SubscriptionStatus;
  provisioningStatus?: ProvisioningStatus;
  startDate?: string | null;
  endDate?: string | null;
}

export interface SubscriptionChanges {
  userId?: string | null;
  status?: SubscriptionStatus;
  provisioningStatus?: ProvisioningStatus;
  provisioningError?: string | null;
  paymentProviderSubscriptionId?: string | null;
  paymentProviderCustomerId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface SubscriptionRepository {
  /**
   * Inserts, or returns the row already there for this checkout session.
   *
   * The whole idempotency story rests on this: the session id carries a unique
   * constraint, so two concurrent deliveries of the same webhook cannot both insert,
   * and the loser reads back the winner's row instead of failing.
   */
  createForCheckout(subscription: NewSubscription): Promise<Subscription>;
  findByCheckoutSession(sessionId: string): Promise<Subscription | undefined>;
  findByProviderSubscriptionId(id: string): Promise<Subscription | undefined>;
  findByEmail(email: string): Promise<Subscription | undefined>;
  /**
   * The subscription an account's entitlements are read from.
   *
   * Most recent first when an account has more than one row - a re-subscribe after a
   * cancellation leaves the old row in place, and the live one is what it may use.
   */
  findByUserId(userId: string): Promise<Subscription | undefined>;
  findById(id: string): Promise<Subscription | undefined>;
  update(
    id: string,
    changes: SubscriptionChanges,
  ): Promise<Subscription | undefined>;
  /** Everything a reconciliation pass should look at: paid, but not fully provisioned. */
  listUnprovisioned(): Promise<readonly Subscription[]>;
}

/**
 * The webhook events already acted upon.
 *
 * Payment providers guarantee at-least-once delivery, so "have I seen this event id?"
 * has to be answered from storage. `claim` returns false when the event was already
 * recorded, which is the signal to stop.
 */
export interface ProcessedEventRepository {
  claim(
    eventId: string,
    eventType: string,
  ): Promise<boolean>;
  release(eventId: string): Promise<void>;
}

export const SUBSCRIPTION_REPOSITORY = Symbol(
  'faultline.subscription-repository',
);
export const PROCESSED_EVENT_REPOSITORY = Symbol(
  'faultline.processed-event-repository',
);

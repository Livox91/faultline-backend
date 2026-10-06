import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  PLANS,
  isFreePlan,
  isPlanId,
  isSelfServePlan,
  planOrThrow,
  type PlanId,
  type SubscriptionLifecycleUpdate,
  type SubscriptionStatus,
} from '@faultline/billing';
import type { ConfirmedPayment } from './provisioning.service';

export const PAYMENT_GATEWAY = Symbol('faultline.payment-gateway');

export interface CheckoutRequest {
  readonly plan: PlanId;
  readonly email: string;
  readonly fullName?: string;
  readonly requestedUsername?: string;
}

export interface CheckoutSession {
  readonly id: string;
  /** Where the browser is sent to pay. Hosted by the provider, never by us. */
  readonly url: string;
}

export interface VerifiedBillingEvent {
  readonly id: string;
  readonly type: string;
  readonly payment?: ConfirmedPayment;
  readonly lifecycle?: SubscriptionLifecycleUpdate;
}

/**
 * What the API needs from a payment provider.
 *
 * Kept to three operations so a second provider is a new class rather than a rewrite:
 * open a checkout, turn a signed webhook into a confirmed payment, and read a session
 * back when the browser returns.
 */
export interface PaymentGateway {
  readonly provider: string;
  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;
  /** Opens the provider-hosted account-management portal for an existing customer. */
  createCustomerPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<{ url: string }>;
  /**
   * Verifies the provider's signature over the raw body and returns the event.
   *
   * Takes the raw bytes, not a parsed object: the signature covers the exact payload,
   * and re-serialising JSON changes it. Throws when verification fails, which is the
   * only thing standing between this endpoint and an anonymous request that asks us to
   * create an Admin account.
   */
  verifyWebhook(
    payload: Buffer,
    signature: string,
  ): VerifiedBillingEvent;
  /** Reads a session back, so the return page can report status without guessing. */
  getCheckoutStatus(
    sessionId: string,
  ): Promise<{ paid: boolean; email: string | null }>;
}

@Injectable()
export class StripeGateway implements PaymentGateway {
  readonly provider = 'stripe';
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    const secretKey = config.billing.secretKey;
    if (!secretKey)
      throw new Error('STRIPE_SECRET_KEY is required when billing is enabled');
    this.webhookSecret = config.billing.webhookSecret ?? '';
    this.stripe = new Stripe(secretKey, {
      // Pinned deliberately: an account-wide API version change should not alter the
      // shape of the events that provision admin accounts without a deploy.
      apiVersion: '2026-08-26.dahlia',
      telemetry: false,
    });
  }

  async createCheckoutSession(
    request: CheckoutRequest,
  ): Promise<CheckoutSession> {
    const plan = planOrThrow(request.plan);
    if (!isSelfServePlan(plan))
      throw new Error(`Plan ${plan.id} is not sold through hosted checkout`);
    const priceId = this.config.billing.priceIds[plan.id];
    if (!priceId)
      throw new Error(`No configured price for plan ${plan.id}`);

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: request.email,
        // Stripe asks for a card on a subscription even when the amount is zero unless
        // told not to. Without this the free tier would demand card details for nothing
        // and never reach `no_payment_required`, which is what we provision it on.
        ...(isFreePlan(plan)
          ? { payment_method_collection: 'if_required' as const }
          : {}),
        // Carried through the provider and read back off the webhook. Putting the
        // purchaser's intent here rather than in our own pending table means there is
        // no second record to keep in step with the payment.
        metadata: {
          plan: plan.id,
          ...(request.fullName ? { fullName: request.fullName } : {}),
          ...(request.requestedUsername
            ? { requestedUsername: request.requestedUsername }
            : {}),
        },
        subscription_data: { metadata: { plan: plan.id } },
        success_url: `${this.config.publicUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.config.publicUrl}/payment/cancel`,
      },
      {
        // Stripe-side idempotency: a double-clicked Subscribe button reuses the
        // session instead of opening a second one against the same customer.
        idempotencyKey: `checkout:${request.email.toLowerCase()}:${plan.id}:${Math.floor(
          Date.now() / 60_000,
        )}`,
      },
    );

    if (!session.url)
      throw new Error('Stripe did not return a checkout URL');
    return { id: session.id, url: session.url };
  }

  async createCustomerPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  verifyWebhook(
    payload: Buffer,
    signature: string,
  ): VerifiedBillingEvent {
    if (!this.webhookSecret)
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');

    // Throws on a bad signature, a missing timestamp, or one outside the tolerance
    // window - which also makes captured-and-replayed deliveries useless.
    const event = this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );

    return {
      id: event.id,
      type: event.type,
      ...(event.type === 'checkout.session.completed'
        ? { payment: toConfirmedPayment(event.data.object) }
        : {}),
      ...(['invoice.paid', 'invoice.payment_failed',
        'customer.subscription.updated', 'customer.subscription.deleted'].includes(
        event.type,
      )
        ? { lifecycle: toSubscriptionLifecycle(event, this.config) }
        : {}),
    };
  }

  async getCheckoutStatus(
    sessionId: string,
  ): Promise<{ paid: boolean; email: string | null }> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    const plan = session.metadata?.plan;
    const free = isPlanId(plan) && isFreePlan(PLANS[plan]);
    return {
      // The free tier never reports `paid`; for it, "nothing to pay" is the success
      // state, and the return page should say so rather than look stuck.
      paid:
        session.payment_status === 'paid' ||
        (free && session.payment_status === 'no_payment_required'),
      email: session.customer_details?.email ?? session.customer_email ?? null,
    };
  }
}

function toSubscriptionLifecycle(
  event: Stripe.Event,
  config: ApplicationConfig,
): SubscriptionLifecycleUpdate | undefined {
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as Stripe.Invoice;
    const modern = invoice.parent?.subscription_details?.subscription;
    const legacy = (
      invoice as Stripe.Invoice & {
        subscription?: string | Stripe.Subscription | null;
      }
    ).subscription;
    const providerSubscriptionId = idOf(modern ?? legacy);
    if (!providerSubscriptionId) return undefined;
    const plan = planFromInvoice(invoice, config);
    return {
      type: event.type,
      providerSubscriptionId,
      customerId: idOf(invoice.customer),
      ...(plan ? { plan } : {}),
      status: event.type === 'invoice.paid' ? 'active' : 'past_due',
      startDate: toIso(invoice.period_start),
      endDate: toIso(invoice.period_end),
    };
  }

  if (
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const subscription = event.data.object as Stripe.Subscription;
    const item = subscription.items.data[0];
    const plan = planFromSubscription(subscription, config);
    return {
      type: event.type,
      providerSubscriptionId: subscription.id,
      customerId: idOf(subscription.customer),
      ...(plan ? { plan } : {}),
      status:
        event.type === 'customer.subscription.deleted'
          ? 'canceled'
          : subscriptionStatus(subscription.status),
      startDate: toIso(item?.current_period_start ?? subscription.start_date),
      endDate: toIso(
        item?.current_period_end ?? subscription.ended_at ?? subscription.cancel_at,
      ),
    };
  }

  return undefined;
}

function planFromSubscription(
  subscription: Stripe.Subscription,
  config: ApplicationConfig,
): PlanId | undefined {
  const priceId = subscription.items.data[0]?.price.id;
  const configured = planFromPriceId(priceId, config);
  // The current Price is authoritative for portal upgrades/downgrades. Metadata is a
  // fallback for subscriptions whose price configuration was rotated after purchase.
  if (configured) return configured;
  return isPlanId(subscription.metadata?.plan)
    ? subscription.metadata.plan
    : undefined;
}

function planFromInvoice(
  invoice: Stripe.Invoice,
  config: ApplicationConfig,
): PlanId | undefined {
  for (const line of invoice.lines.data) {
    const price = line.pricing?.price_details?.price;
    const configured = planFromPriceId(idOf(price), config);
    if (configured) return configured;
  }
  // Subscription invoice line metadata reflects subscription metadata in Stripe and
  // remains a useful fallback if a Price id was rotated after the invoice was issued.
  return invoice.lines.data
    .map((line) => line.metadata?.plan)
    .find((plan): plan is PlanId => isPlanId(plan));
}

function planFromPriceId(
  priceId: string | null | undefined,
  config: ApplicationConfig,
): PlanId | undefined {
  return priceId
    ? (Object.entries(config.billing.priceIds) as [PlanId, string | undefined][])
        .find(([, candidate]) => candidate === priceId)?.[0]
    : undefined;
}

function subscriptionStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    case 'incomplete_expired':
    case 'canceled':
      return 'canceled';
    default:
      // Stripe may add a status before this SDK is upgraded. Fail closed: an unknown
      // state must never grant paid entitlements.
      return 'incomplete';
  }
}

const toIso = (seconds: number | null | undefined): string | undefined =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : undefined;

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null);

/**
 * Reads a completed checkout session into the shape provisioning needs.
 *
 * `payment_status` is checked rather than assumed: `checkout.session.completed` also
 * fires for sessions that finished without money changing hands, and provisioning an
 * Admin for one of those would be the exact failure this whole design avoids. The one
 * exception is a tier whose price is zero, where `no_payment_required` *is* a
 * successful outcome - decided from our own catalog, not from the session.
 */
function toConfirmedPayment(
  session: Stripe.Checkout.Session,
): ConfirmedPayment | undefined {
  const plan = session.metadata?.plan;
  // A plan we do not sell - or none at all - is not ours to act on, whoever signed it.
  if (!isPlanId(plan) || !isSelfServePlan(PLANS[plan])) return undefined;

  // A free tier settles as `no_payment_required`, never as `paid`. Accepting it is
  // narrowly scoped to plans whose list amount really is zero, so a paid plan that
  // somehow completed without money still provisions nothing.
  const settled =
    session.payment_status === 'paid' ||
    (session.payment_status === 'no_payment_required' && isFreePlan(PLANS[plan]));
  if (!settled) return undefined;

  const email = session.customer_details?.email ?? session.customer_email;
  if (!email) return undefined;

  return {
    checkoutSessionId: session.id,
    email,
    plan,
    status: 'active',
    customerId: idOf(session.customer),
    subscriptionId: idOf(session.subscription),
    requestedUsername: session.metadata?.requestedUsername ?? null,
    fullName: session.metadata?.fullName ?? session.customer_details?.name ?? null,
    startDate: new Date(session.created * 1000).toISOString(),
  };
}

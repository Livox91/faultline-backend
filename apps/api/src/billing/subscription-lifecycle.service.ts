import { Inject, Injectable } from '@nestjs/common';
import {
  SUBSCRIPTION_REPOSITORY,
  type Subscription,
  type SubscriptionLifecycleUpdate,
  type SubscriptionRepository,
} from '@faultline/billing';
import { ApplicationLogger } from '@faultline/platform';

export type LifecycleOutcome =
  | { kind: 'updated'; subscription: Subscription }
  | { kind: 'not-found' };

/** Applies already-verified provider lifecycle events to the local subscription row. */
@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    private readonly logger: ApplicationLogger,
  ) {}

  async apply(update: SubscriptionLifecycleUpdate): Promise<LifecycleOutcome> {
    const existing = await this.subscriptions.findByProviderSubscriptionId(
      update.providerSubscriptionId,
    );
    if (!existing) {
      this.logger.warn({
        event: 'subscription_lifecycle_unmatched',
        stripe_event_type: update.type,
        provider_subscription_id: update.providerSubscriptionId,
      });
      return { kind: 'not-found' };
    }

    // Provider delivery order is not guaranteed. A late invoice event for a subscription
    // already deleted must not resurrect it; a new purchase has a new provider id.
    const status =
      existing.status === 'canceled' && update.type.startsWith('invoice.')
        ? 'canceled'
        : update.status;
    // A lapsed paid subscription becomes the free tier in storage as well as in the
    // entitlement guard. A later successful invoice carries its Stripe Price, allowing
    // the gateway to restore Pro without manual intervention.
    const plan = status === 'canceled' || status === 'past_due' ? 'basic' : update.plan;
    const subscription = await this.subscriptions.update(existing.id, {
      status,
      ...(plan ? { plan } : {}),
      ...(update.customerId ? { paymentProviderCustomerId: update.customerId } : {}),
      ...(update.startDate ? { startDate: update.startDate } : {}),
      ...(update.endDate ? { endDate: update.endDate } : {}),
    });
    if (!subscription)
      throw new Error(`Subscription ${existing.id} disappeared during lifecycle update`);

    this.logger.log({
      event: 'subscription_lifecycle_applied',
      stripe_event_type: update.type,
      subscription_id: subscription.id,
      status: subscription.status,
      plan: subscription.plan,
    });
    return { kind: 'updated', subscription };
  }
}

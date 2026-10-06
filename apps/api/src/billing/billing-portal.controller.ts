import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Header,
  Inject,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ROLES, type AuthenticatedUser } from '@faultline/auth';
import { PLAN_RANK, PLANS, isPlanId } from '@faultline/billing';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import { CurrentUser, Roles } from '../auth/context';
import { PlanEntitlements } from './entitlements';
import { PAYMENT_GATEWAY, type PaymentGateway } from './stripe.gateway';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * Opens Stripe's hosted account-management surface for an organization's owner.
 *
 * Payment details, invoices and cancellation controls stay on Stripe. The API returns
 * only a short-lived portal URL, and never receives card data. Admin-only access keeps
 * an onsite engineer from changing the organization's commercial relationship.
 */
@Controller('billing')
export class BillingPortalController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly entitlements: PlanEntitlements,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly logger: ApplicationLogger,
  ) {}

  /** Starts an authenticated plan upgrade without trusting identity data from the UI. */
  @Post('upgrade')
  @Roles(ROLES.ADMIN)
  @Header('Cache-Control', 'no-store')
  async upgrade(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ) {
    const target = typeof body?.plan === 'string' ? body.plan : '';
    if (!isPlanId(target) || target !== 'pro')
      throw new BadRequestException('Only the Pro plan is available for online upgrade');

    const currentPlan = await this.entitlements.planFor(user);
    if (PLAN_RANK[target] <= PLAN_RANK[currentPlan])
      throw new ConflictException(`This organization is already on ${PLANS[currentPlan].name}`);

    const subscription = await this.entitlements.subscriptionFor(user);
    try {
      const session = await this.gateway.createCheckoutSession({
        plan: target,
        email: user.email,
        fullName: user.name,
        ...(subscription?.paymentProvider === this.gateway.provider &&
        subscription.paymentProviderCustomerId
          ? { customerId: subscription.paymentProviderCustomerId }
          : {}),
        successUrl: `${this.config.publicUrl}/admin/subscription?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${this.config.publicUrl}/admin/subscription?checkout=cancel`,
      });
      return { checkoutUrl: session.url, sessionId: session.id };
    } catch (error) {
      this.logger.error({
        event: 'subscription_upgrade_session_failed',
        user_id: user.id,
        target_plan: target,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw new ServiceUnavailableException(
        'The upgrade checkout is unavailable; please try again shortly',
      );
    }
  }

  @Post('portal')
  @Roles(ROLES.ADMIN)
  @Header('Cache-Control', 'no-store')
  async create(@CurrentUser() user: AuthenticatedUser) {
    const subscription = await this.entitlements.subscriptionFor(user);
    if (
      !subscription ||
      subscription.paymentProvider !== this.gateway.provider ||
      !subscription.paymentProviderCustomerId
    ) {
      throw new BadRequestException(
        'No Stripe billing customer is attached to this organization',
      );
    }

    try {
      const session = await this.gateway.createCustomerPortalSession(
        subscription.paymentProviderCustomerId,
        `${this.config.publicUrl}/admin/subscription`,
      );
      return { portalUrl: session.url };
    } catch (error) {
      this.logger.error({
        event: 'billing_portal_session_failed',
        user_id: user.id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw new ServiceUnavailableException(
        'The billing portal is unavailable; please try again shortly',
      );
    }
  }

  /** Reconciles local billing state with Stripe when the billing page is opened. */
  @Post('sync')
  @Roles(ROLES.ADMIN)
  @Header('Cache-Control', 'no-store')
  async sync(@CurrentUser() user: AuthenticatedUser) {
    const subscription = await this.entitlements.subscriptionFor(user);
    if (
      !subscription ||
      subscription.paymentProvider !== this.gateway.provider ||
      !subscription.paymentProviderSubscriptionId
    ) {
      throw new BadRequestException(
        'No Stripe subscription is attached to this organization',
      );
    }

    try {
      const update = await this.gateway.getSubscriptionLifecycle(
        subscription.paymentProviderSubscriptionId,
      );
      const outcome = await this.lifecycle.apply(update);
      if (outcome.kind === 'not-found')
        throw new Error('The Stripe subscription is not available locally');
      return { synchronized: true };
    } catch (error) {
      this.logger.error({
        event: 'billing_subscription_sync_failed',
        user_id: user.id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw new ServiceUnavailableException(
        'Subscription status could not be refreshed; please try again shortly',
      );
    }
  }
}

import {
  BadRequestException,
  Controller,
  Header,
  Inject,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ROLES, type AuthenticatedUser } from '@faultline/auth';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import { CurrentUser, Roles } from '../auth/context';
import { PlanEntitlements } from './entitlements';
import { PAYMENT_GATEWAY, type PaymentGateway } from './stripe.gateway';

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
    private readonly logger: ApplicationLogger,
  ) {}

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
}

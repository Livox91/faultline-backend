import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  APPLICATION_CONFIG,
  ApplicationLogger,
  type ApplicationConfig,
} from '@faultline/platform';
import {
  PLANS,
  PROCESSED_EVENT_REPOSITORY,
  formatAmount,
  isPlanId,
  isSelfServePlan,
  planIds,
  type ProcessedEventRepository,
} from '@faultline/billing';
import { isValidUsername } from '@faultline/auth';
import { Public } from '../auth/context';
import { PAYMENT_GATEWAY, type PaymentGateway } from './stripe.gateway';
import { SubscriptionProvisioningService } from './provisioning.service';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The public purchase surface.
 *
 * Every route here is `@Public()` by necessity: the person buying a subscription does
 * not have an account yet - creating one is the point. That makes this the only part of
 * the API an anonymous caller can reach beyond health and login, so each route is
 * deliberately narrow, and the one that actually creates an Admin (`/webhook`) trusts
 * nothing but a valid provider signature.
 */
@Controller('billing')
export class BillingController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PROCESSED_EVENT_REPOSITORY)
    private readonly processedEvents: ProcessedEventRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly provisioning: SubscriptionProvisioningService,
    private readonly logger: ApplicationLogger,
  ) {}

  /**
   * What the public pricing page renders. No secrets, no provider round trip.
   *
   * Every tier is listed, including the one that cannot be bought here: a pricing page
   * that hides Enterprise is a pricing page people ask questions about. `checkout`
   * tells the client which button to draw, so the rule about what is self-serve lives
   * in the catalog rather than being restated in the UI.
   */
  @Public()
  @Get('plans')
  @Header('Cache-Control', 'public, max-age=300')
  plans() {
    return {
      applicationName: this.config.applicationName,
      salesContact: this.config.billing.salesContact ?? null,
      plans: planIds.map((id) => ({
        ...PLANS[id],
        priceLabel: formatAmount(PLANS[id].amount, PLANS[id].currency),
        // A self-serve tier with no configured price cannot be sold, so the card says
        // so rather than offering a button that can only fail.
        available:
          !isSelfServePlan(PLANS[id]) || !!this.config.billing.priceIds[id],
      })),
    };
  }

  /**
   * Opens a hosted checkout and hands back the URL to send the browser to.
   *
   * Card details never touch this application: the customer enters them on the
   * provider's page, which keeps this codebase out of PCI scope entirely. Nothing is
   * created here - no user, no pending account - because nothing has been paid yet.
   */
  @Public()
  @Post('checkout')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async checkout(@Body() body: Record<string, unknown>) {
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!EMAIL_PATTERN.test(email))
      throw new BadRequestException('A valid email address is required');

    const plan = typeof body?.plan === 'string' ? body.plan : 'pro';
    if (!isPlanId(plan)) throw new BadRequestException('Unknown plan');
    // Enterprise has no list price, so there is nothing honest to open a checkout for.
    // Said plainly here rather than left to surface as a provider failure it is not.
    if (!isSelfServePlan(PLANS[plan]))
      throw new BadRequestException(
        `The ${PLANS[plan].name} plan is arranged with our sales team, not through checkout`,
      );
    if (!this.config.billing.priceIds[plan])
      throw new BadRequestException(
        `The ${PLANS[plan].name} plan is not currently available`,
      );

    const requestedUsername =
      typeof body?.username === 'string' && body.username.trim()
        ? body.username.trim().toLowerCase()
        : undefined;
    // Rejected now rather than silently replaced later, so the purchaser finds out
    // while they can still change it.
    if (requestedUsername && !isValidUsername(requestedUsername))
      throw new BadRequestException(
        'Username must be 3-32 characters: letters, digits, dot, dash or underscore',
      );

    const fullName =
      typeof body?.fullName === 'string' && body.fullName.trim()
        ? body.fullName.trim().slice(0, 120)
        : undefined;

    try {
      const session = await this.gateway.createCheckoutSession({
        plan,
        email,
        ...(fullName ? { fullName } : {}),
        ...(requestedUsername ? { requestedUsername } : {}),
      });
      return { checkoutUrl: session.url, sessionId: session.id };
    } catch (error) {
      this.logger.error({
        event: 'checkout_session_failed',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw new ServiceUnavailableException(
        'The payment provider is unavailable; please try again shortly',
      );
    }
  }

  /**
   * The only route that creates an Admin account.
   *
   * Three things make it safe to expose publicly:
   *
   *  - the raw body is verified against the provider's signature, so a forged POST is
   *    rejected before anything is read out of it;
   *  - the event id is claimed in the database, so a redelivery does nothing;
   *  - provisioning itself is idempotent, so even a claim that slips through cannot
   *    produce a second account.
   *
   * On failure the claim is released and a 5xx is returned, because the provider's
   * retry is the recovery mechanism - swallowing the error would turn a transient
   * database blip into a customer who paid and never got an account.
   */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async webhook(@Req() request: RawBodyRequest<{ headers: Record<string, unknown> }>) {
    const signature = request.headers['stripe-signature'];
    const raw = request.rawBody;
    if (typeof signature !== 'string' || !raw)
      throw new UnauthorizedException('Missing webhook signature');

    let event: { id: string; type: string; payment?: unknown };
    try {
      event = this.gateway.verifyWebhook(raw, signature);
    } catch (error) {
      this.logger.warn({
        event: 'webhook_signature_rejected',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      // 401, not 400: this was an unauthenticated caller, and saying so keeps the
      // provider's dashboard honest about what happened.
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const claimed = await this.processedEvents.claim(event.id, event.type);
    if (!claimed) {
      this.logger.log({ event: 'webhook_duplicate_ignored', stripe_event: event.id });
      return { received: true, duplicate: true };
    }

    const payment = event.payment as
      | Parameters<SubscriptionProvisioningService['provision']>[0]
      | undefined;
    if (!payment) {
      // A signed event we do not act on - a renewal invoice, a cancellation. The claim
      // stands so it is not reconsidered, and 200 stops the provider retrying.
      this.logger.log({ event: 'webhook_ignored', type: event.type });
      return { received: true, handled: false };
    }

    try {
      const outcome = await this.provisioning.provision(payment);
      return { received: true, handled: true, outcome: outcome.kind };
    } catch (error) {
      // Let the provider retry: the claim must not outlive a failed attempt.
      await this.processedEvents.release(event.id);
      throw error;
    }
  }

  /**
   * What the return page shows.
   *
   * Reports only whether the provider considers the session paid. It deliberately does
   * not report whether the account exists yet, and never returns credentials: the
   * webhook provisions asynchronously, and the credentials go to the purchaser's
   * mailbox, not to whoever happens to be holding this session id.
   */
  @Public()
  @Get('checkout/status')
  @Header('Cache-Control', 'no-store')
  async checkoutStatus(@Query('sessionId') sessionId: unknown) {
    if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId))
      throw new BadRequestException('A checkout session id is required');
    try {
      const status = await this.gateway.getCheckoutStatus(sessionId);
      return {
        paid: status.paid,
        // Echoed back only so the page can say "check name@example.com"; it comes from
        // the provider's record of the session, not from the query string.
        email: status.email,
      };
    } catch {
      throw new BadRequestException('Unknown checkout session');
    }
  }
}

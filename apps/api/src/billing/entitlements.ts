import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from '@faultline/platform';
import { AUDIT_ACTIONS } from '@faultline/auth';
import {
  FEATURE_LABELS,
  PLANS,
  SUBSCRIPTION_REPOSITORY,
  entitledPlan,
  featuresFor,
  minimumPlanFor,
  planIncludes,
  type PlanFeature,
  type PlanId,
  type SubscriptionRepository,
} from '@faultline/billing';
import { AuditTrail } from '../auth/audit-trail';
import { IS_PUBLIC, REQUIRED_FEATURE, type RequestWithUser } from '../auth/context';

/**
 * What tier an account is on, and therefore which modules it may reach.
 *
 * One service rather than a rule in the guard and a second copy in the endpoint that
 * reports entitlements to the UI: if the two could disagree, the console would offer a
 * button the API refuses, which is the worst version of this feature.
 */
@Injectable()
export class PlanEntitlements {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /**
   * Whether tiers are enforced at all.
   *
   * A deployment with billing off sells nothing, so nobody has a subscription and every
   * account would fall to the free tier - which would silently switch off paid modules
   * for every self-hosted installation. Off means unenforced, not "everyone is Basic".
   */
  get enforced(): boolean {
    return this.config.billing.enabled;
  }

  /** The tier this account is entitled to right now. Read per request, never cached. */
  async planFor(userId: string): Promise<PlanId> {
    const subscription = await this.subscriptions.findByUserId(userId);
    return entitledPlan(subscription ?? null);
  }

  async featuresForUser(userId: string): Promise<readonly PlanFeature[]> {
    return featuresFor(await this.planFor(userId));
  }
}

/**
 * Enforces `@RequiresFeature`, after role and project authorization have agreed.
 *
 * Kept out of `AuthorizationGuard` because it answers a commercial question rather than
 * an identity one, and because it costs a query: only a route that declares a module
 * pays for the lookup. Denials still go through the same `AuditTrail`, so a refusal for
 * "not on your plan" is as visible to an operator as one for "not your project".
 *
 * Ordering matters and is not incidental: this runs last, so a caller who is not
 * authenticated, or who owes a password change, or who is reaching into a project that
 * is not theirs, is refused on those grounds before their plan is ever consulted. That
 * keeps the subscription tier out of answers about who someone is.
 */
@Injectable()
export class EntitlementsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: PlanEntitlements,
    private readonly audit: AuditTrail,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<PlanFeature>(
      REQUIRED_FEATURE,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    if (!this.entitlements.enforced) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Authentication required');

    const plan = await this.entitlements.planFor(user.id);
    if (planIncludes(plan, feature)) return true;

    const required = minimumPlanFor(feature);
    await this.audit.record({
      user,
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      resourceType: 'feature',
      resourceId: feature,
      outcome: 'denied',
      request,
      metadata: {
        check: 'plan',
        feature,
        plan,
        required,
        method: request.method ?? null,
        path: request.originalUrl ?? request.url ?? null,
      },
    });

    // A structured body, not just a sentence: the console shows an upgrade prompt from
    // this, and guessing the required tier by parsing prose would be worse.
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message: `${FEATURE_LABELS[feature]} is not included in your ${PLANS[plan].name} plan`,
      feature,
      featureLabel: FEATURE_LABELS[feature],
      plan,
      requiredPlan: required,
      requiredPlanName: PLANS[required].name,
    });
  }
}

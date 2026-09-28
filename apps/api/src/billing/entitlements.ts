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
import {
  AUDIT_ACTIONS,
  ROLES,
  USER_REPOSITORY,
  type AuthenticatedUser,
  type UserRepository,
} from '@faultline/auth';
import {
  FEATURES,
  FEATURE_LABELS,
  PLANS,
  PLAN_RANK,
  SUBSCRIPTION_REPOSITORY,
  clusterLimitFor,
  entitledPlan,
  featuresFor,
  minimumPlanFor,
  planAllowingClusters,
  planIncludes,
  type PlanFeature,
  type PlanId,
  type Subscription,
  type SubscriptionRepository,
} from '@faultline/billing';
import type { ClusterDirectory } from '@faultline/database';
import { AuditTrail } from '../auth/audit-trail';
import { IS_PUBLIC, REQUIRED_FEATURE, type RequestWithUser } from '../auth/context';

/**
 * What tier an account is on, and therefore which modules it may reach.
 *
 * One service rather than a rule in the guard and a second copy in the endpoint that
 * reports entitlements to the UI: if the two could disagree, the console would offer a
 * button the API refuses, which is the worst version of this feature.
 */
/** Who is asking: enough to find their own and their organization's subscription. */
export type EntitledUser = Pick<AuthenticatedUser, 'id' | 'organizationId'>;

@Injectable()
export class PlanEntitlements {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
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

  /**
   * The subscription an account's tier comes from.
   *
   * A plan is bought by the organization's owner, but everyone in the organization
   * works under it: an engineer an Admin created has no subscription of their own, and
   * reading only theirs would put every engineer on the free tier. So the account's own
   * subscription and those of its organization's Admins are all candidates, and the one
   * granting the highest live tier wins.
   */
  async subscriptionFor(user: EntitledUser): Promise<Subscription | undefined> {
    const own = await this.subscriptions.findByUserId(user.id);
    const owners = (await this.users.list()).filter(
      (candidate) =>
        candidate.id !== user.id &&
        candidate.organizationId === user.organizationId &&
        candidate.role === ROLES.ADMIN,
    );
    const theirs = await Promise.all(
      owners.map((owner) => this.subscriptions.findByUserId(owner.id)),
    );
    let best: Subscription | undefined;
    for (const candidate of [own, ...theirs]) {
      if (!candidate) continue;
      if (!best || PLAN_RANK[entitledPlan(candidate)] > PLAN_RANK[entitledPlan(best)])
        best = candidate;
    }
    return best;
  }

  /** The tier this account is entitled to right now. Read per request, never cached. */
  async planFor(user: EntitledUser): Promise<PlanId> {
    return entitledPlan((await this.subscriptionFor(user)) ?? null);
  }

  async featuresForUser(user: EntitledUser): Promise<readonly PlanFeature[]> {
    return featuresFor(await this.planFor(user));
  }

  /**
   * Refuses a new cluster once the organization has used its tier's allowance.
   *
   * Counted across the whole organization rather than the caller's assignments: the
   * allowance is the organization's, and an Admin who is not assigned to a cluster must
   * not be able to register a second one past it. Registering is refused up front, before
   * anything is installed, so a refusal leaves nothing behind to clean up.
   */
  async assertClusterCapacity(
    user: EntitledUser,
    clusters: Pick<ClusterDirectory, 'list'>,
  ): Promise<void> {
    if (!this.enforced) return;
    const plan = await this.planFor(user);
    const limit = clusterLimitFor(plan);
    if (limit === null) return;
    const used = (await clusters.list(undefined, user.organizationId)).length;
    if (used < limit) return;

    const required = planAllowingClusters(used);
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message: `Your ${PLANS[plan].name} plan includes ${limit} cluster${limit === 1 ? '' : 's'}. Upgrade to ${PLANS[required].name} to connect more, or uninstall a cluster first.`,
      feature: FEATURES.CLUSTER_ONBOARDING,
      featureLabel: FEATURE_LABELS[FEATURES.CLUSTER_ONBOARDING],
      limit: { clusters: limit, used },
      plan,
      requiredPlan: required,
      requiredPlanName: PLANS[required].name,
    });
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

    const plan = await this.entitlements.planFor(user);
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

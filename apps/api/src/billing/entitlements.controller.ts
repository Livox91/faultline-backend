import { Controller, Get, Header, Inject } from '@nestjs/common';
import {
  FEATURE_LABELS,
  FEATURES,
  PLANS,
  clusterLimitFor,
  entitledPlan,
  featuresFor,
  minimumPlanFor,
  type PlanFeature,
} from '@faultline/billing';
import type { AuthenticatedUser } from '@faultline/auth';
import type { ClusterDirectory } from '@faultline/database';
import { CurrentUser } from '../auth/context';
import { CLUSTER_DIRECTORY } from '../clusters.controller';
import { PlanEntitlements } from './entitlements';

const ALL_FEATURES = Object.values(FEATURES) as readonly PlanFeature[];

const describe = (feature: PlanFeature) => ({
  id: feature,
  label: FEATURE_LABELS[feature],
});

/**
 * What the signed-in account's plan unlocks.
 *
 * Registered whether or not billing is enabled, because the console needs an answer
 * either way - with billing off it reports everything as available and says so through
 * `enforced`, rather than leaving the UI to infer a tier from a missing route.
 *
 * It reports the same decision the guard enforces, from the same service. The `locked`
 * list is deliberate: a console that knows *why* a module is unavailable can offer the
 * upgrade, where one that simply omits it leaves the customer wondering.
 */
@Controller('billing')
export class EntitlementsController {
  constructor(
    private readonly entitlements: PlanEntitlements,
    @Inject(CLUSTER_DIRECTORY) private readonly clusters: ClusterDirectory,
  ) {}

  @Get('entitlements')
  @Header('Cache-Control', 'no-store')
  async mine(@CurrentUser() user: AuthenticatedUser) {
    const enforced = this.entitlements.enforced;
    // The organization's subscription, so an engineer sees the tier their owner bought.
    const [subscription, clusters] = await Promise.all([
      enforced ? this.entitlements.subscriptionFor(user) : undefined,
      this.clusters.list(undefined, user.organizationId),
    ]);
    const plan = enforced ? entitledPlan(subscription ?? null) : 'enterprise';
    const granted = new Set(featuresFor(plan));

    return {
      plan,
      planName: PLANS[plan].name,
      /** False on a self-hosted deployment that sells nothing; no module is withheld. */
      enforced,
      // Never the provider's customer or subscription ids: this route answers "what may
      // I use", and the billing relationship is not part of that answer.
      subscriptionStatus: subscription?.status ?? null,
      /** Allowances on included modules; `null` is unlimited. */
      limits: { clusters: enforced ? clusterLimitFor(plan) : null },
      /** Current organization-wide consumption of those allowances. */
      usage: { clusters: clusters.length },
      features: [...granted].map(describe),
      locked: ALL_FEATURES.filter((feature) => !granted.has(feature)).map(
        (feature) => {
          const required = minimumPlanFor(feature);
          return {
            ...describe(feature),
            requiredPlan: required,
            requiredPlanName: PLANS[required].name,
          };
        },
      ),
    };
  }
}

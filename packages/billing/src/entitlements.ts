import { PLANS, planIds, type PlanId } from './plans';

/**
 * What a tier lets you reach.
 *
 * This is the machine-readable half of the catalog: `Plan.features` is prose for the
 * pricing page, and these are the ids the API enforces. They are kept apart on purpose -
 * marketing copy gets reworded, and a reworded bullet must never quietly open or close
 * a module.
 *
 * Note what this is *not*. It answers "does this account's plan include this module?",
 * which is a commercial question, and it composes with - never replaces - the role and
 * project checks that answer "is this person allowed to do this?". An Admin on Basic is
 * still an Admin; there is simply no Voice Call Agent on their plan to administer.
 */
export const FEATURES = {
  // Basic: connect a cluster and follow its incidents.
  CLUSTERS: 'clusters',
  CLUSTER_ONBOARDING: 'cluster-onboarding',
  INCIDENTS: 'incidents',
  ALERTS: 'alerts',
  INCIDENT_LEDGER: 'incident-ledger',
  // Pro: every other console module.
  TEAM_MANAGEMENT: 'team-management',
  INTEGRATIONS: 'integrations',
  LOG_AGGREGATOR: 'log-aggregator',
  REPORTING: 'reporting',
  VOICE_AGENT: 'voice-call-agent',
  // Enterprise.
  AUTO_REMEDIATION: 'auto-remediation',
} as const;

export type PlanFeature = (typeof FEATURES)[keyof typeof FEATURES];

/**
 * Display names, so the API, the pricing page and a 403 all say the same words. They
 * match the console's navigation, which is where a customer meets each module.
 */
export const FEATURE_LABELS: Readonly<Record<PlanFeature, string>> =
  Object.freeze({
    [FEATURES.CLUSTERS]: 'Onboarded Clusters',
    [FEATURES.CLUSTER_ONBOARDING]: 'Cluster Onboarding',
    [FEATURES.INCIDENTS]: 'Incidents',
    [FEATURES.ALERTS]: 'Alerts',
    [FEATURES.INCIDENT_LEDGER]: 'Incident Ledger',
    [FEATURES.TEAM_MANAGEMENT]: 'Team & Roles',
    [FEATURES.INTEGRATIONS]: 'Integrations',
    [FEATURES.LOG_AGGREGATOR]: 'Runtime',
    [FEATURES.REPORTING]: 'Reports',
    [FEATURES.VOICE_AGENT]: 'Voice Agent',
    [FEATURES.AUTO_REMEDIATION]: 'Remediation',
  });

/**
 * Tier order. Higher includes everything lower.
 *
 * Stated as a rank rather than as three independent lists so "Pro also gets the free
 * modules" is a property of the model instead of something each list has to remember -
 * and so a module added to Basic later cannot be accidentally withheld from Enterprise.
 */
export const PLAN_RANK: Readonly<Record<PlanId, number>> = Object.freeze({
  basic: 0,
  pro: 1,
  enterprise: 2,
});

/** What each tier *introduces*. Everything below it is inherited. */
const INTRODUCED_BY: Readonly<Record<PlanId, readonly PlanFeature[]>> =
  Object.freeze({
    basic: Object.freeze([
      FEATURES.CLUSTERS,
      FEATURES.CLUSTER_ONBOARDING,
      FEATURES.INCIDENTS,
      FEATURES.ALERTS,
      FEATURES.INCIDENT_LEDGER,
    ]),
    pro: Object.freeze([
      FEATURES.TEAM_MANAGEMENT,
      FEATURES.INTEGRATIONS,
      FEATURES.LOG_AGGREGATOR,
      FEATURES.REPORTING,
      FEATURES.VOICE_AGENT,
    ]),
    enterprise: Object.freeze([FEATURES.AUTO_REMEDIATION]),
  });

/** The modules a tier adds on top of the one below it, for the pricing page. */
export function featuresIntroducedBy(plan: PlanId): readonly PlanFeature[] {
  return INTRODUCED_BY[plan];
}

/**
 * How many clusters an organization may register on each tier. `null` is unlimited.
 *
 * A limit rather than a module: Basic can onboard, just not without end. Counted per
 * organization, because clusters belong to the organization, not to whoever clicked.
 */
const CLUSTER_LIMITS: Readonly<Record<PlanId, number | null>> = Object.freeze({
  basic: 1,
  pro: null,
  enterprise: null,
});

export function clusterLimitFor(plan: PlanId): number | null {
  return CLUSTER_LIMITS[plan];
}

/** The cheapest tier that allows more than `used` clusters, so a refusal can name it. */
export function planAllowingClusters(used: number): PlanId {
  return (
    planIds.find((id) => {
      const limit = CLUSTER_LIMITS[id];
      return limit === null || limit > used;
    }) ?? 'enterprise'
  );
}

/**
 * The tier an account falls back to when it has no live subscription.
 *
 * Not "nothing": a lapsed or cancelled Pro account keeps the free modules rather than
 * losing its incident history the day a card expires. Downgrade, not eviction.
 */
export const FALLBACK_PLAN: PlanId = 'basic';

/** Everything a tier can reach, its own modules and all inherited ones. */
export function featuresFor(plan: PlanId): readonly PlanFeature[] {
  const rank = PLAN_RANK[plan];
  return planIds
    .filter((id) => PLAN_RANK[id] <= rank)
    .flatMap((id) => INTRODUCED_BY[id]);
}

/** The one question the guard asks. */
export function planIncludes(plan: PlanId, feature: PlanFeature): boolean {
  return featuresFor(plan).includes(feature);
}

/**
 * The cheapest tier carrying a module, so a refusal can name the upgrade rather than
 * just saying no.
 */
export function minimumPlanFor(feature: PlanFeature): PlanId {
  const found = planIds.find((id) => INTRODUCED_BY[id].includes(feature));
  if (!found) throw new Error(`Unknown feature: ${feature}`);
  return found;
}

export function isPlanFeature(value: unknown): value is PlanFeature {
  return (
    typeof value === 'string' &&
    (Object.values(FEATURES) as string[]).includes(value)
  );
}

/**
 * The plan an account is actually entitled to, from its subscription row.
 *
 * `status` is what the provider says about the money, and only `active` buys anything;
 * anything else - cancelled, past due, never subscribed at all - reads as the fallback
 * tier. Deliberately a pure function of the row so the rule is testable without a
 * database and cannot differ between the guard and the endpoint that reports it.
 */
export function entitledPlan(
  subscription: { plan: PlanId; status: string } | null | undefined,
): PlanId {
  if (!subscription || subscription.status !== 'active') return FALLBACK_PLAN;
  return PLANS[subscription.plan] ? subscription.plan : FALLBACK_PLAN;
}

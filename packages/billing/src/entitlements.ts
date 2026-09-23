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
  LOG_AGGREGATOR: 'log-aggregator',
  INCIDENT_LEDGER: 'incident-ledger',
  VOICE_AGENT: 'voice-call-agent',
  REPORTING: 'reporting',
  AUTO_REMEDIATION: 'auto-remediation',
} as const;

export type PlanFeature = (typeof FEATURES)[keyof typeof FEATURES];

/** Display names, so the API, the pricing page and a 403 all say the same words. */
export const FEATURE_LABELS: Readonly<Record<PlanFeature, string>> =
  Object.freeze({
    [FEATURES.LOG_AGGREGATOR]: 'Log Aggregator',
    [FEATURES.INCIDENT_LEDGER]: 'Incident Ledger',
    [FEATURES.VOICE_AGENT]: 'Voice Call Agent',
    [FEATURES.REPORTING]: 'Reporting Module',
    [FEATURES.AUTO_REMEDIATION]: 'Auto Remediation',
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
    basic: Object.freeze([FEATURES.LOG_AGGREGATOR, FEATURES.INCIDENT_LEDGER]),
    pro: Object.freeze([FEATURES.VOICE_AGENT, FEATURES.REPORTING]),
    enterprise: Object.freeze([FEATURES.AUTO_REMEDIATION]),
  });

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

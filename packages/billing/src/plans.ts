/**
 * What can be bought.
 *
 * The catalog lives here rather than in the payment provider so the public pricing page
 * can be rendered without a round trip, and so a plan id in a request can be validated
 * against something this codebase owns. The *price* is still the provider's: the
 * checkout session is created from `priceId`, and the amounts below are for display.
 * They must be kept in step with the Stripe price objects they name - which is exactly
 * why the id is configuration and not a literal.
 *
 * Three tiers, and they are not the same kind of thing:
 *
 *  - `basic` is free, but still sold through the provider at a zero-amount recurring
 *    price. That is deliberate: it keeps one provisioning path - checkout, signed
 *    webhook, account, credentials email - instead of a second, unpaid one that would
 *    be a public "create me an Admin" endpoint wearing a different hat.
 *  - `pro` is the ordinary paid tier.
 *  - `enterprise` is priced by conversation, so it has no amount and no price id, and
 *    checkout refuses it rather than inventing a number.
 *
 * `features` here is prose for the pricing page. What a tier actually unlocks is in
 * `entitlements.ts`, which is what the API enforces - a reworded bullet must not open
 * or close a module.
 */

export type PlanId = 'basic' | 'pro' | 'enterprise';

/** How a plan is acquired: self-serve through the provider, or by talking to someone. */
export type PlanCheckout = 'hosted' | 'contact';

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly tagline: string;
  /**
   * Minor units, for display only; the provider charges what its price says.
   * Null when the plan is not sold at a list price (`enterprise`).
   */
  readonly amount: number | null;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly checkout: PlanCheckout;
  /** The one the pricing page leads with. Exactly one plan carries it. */
  readonly recommended: boolean;
  readonly features: readonly string[];
}

export const PLANS: Readonly<Record<PlanId, Plan>> = Object.freeze({
  basic: Object.freeze({
    id: 'basic',
    name: 'Basic',
    tagline: 'For a single team finding its feet.',
    amount: 0,
    currency: 'usd',
    interval: 'month',
    checkout: 'hosted',
    recommended: false,
    features: Object.freeze([
      'Log Aggregator',
      'Incident Ledger',
      'Up to 3 AI agent bots',
      '10,000 LLM tokens / month',
      'Daily scan frequency',
      'Email notifications',
      'Community support',
    ]),
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    tagline: 'For teams running incidents in anger.',
    amount: 4900,
    currency: 'usd',
    interval: 'month',
    checkout: 'hosted',
    recommended: true,
    features: Object.freeze([
      'Everything in Basic',
      'Voice Call Agent',
      'Reporting Module',
      'Up to 10 AI agent bots',
      '100,000 LLM tokens / month',
      'Hourly scan frequency',
      'Slack + email notifications',
      'Priority support',
    ]),
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For estates with compliance in the room.',
    amount: null,
    currency: 'usd',
    interval: 'month',
    checkout: 'contact',
    recommended: false,
    features: Object.freeze([
      'Everything in Pro',
      'Auto Remediation',
      'Unlimited AI agent bots',
      'Unlimited LLM tokens',
      'Real-time scan frequency',
      'Custom AI model fine-tuning',
      'Dedicated SLA and support',
      'Audit logs and compliance exports',
    ]),
  }),
});

export const planIds: readonly PlanId[] = Object.freeze(
  Object.keys(PLANS) as PlanId[],
);

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && planIds.includes(value as PlanId);
}

export function planOrThrow(value: unknown): Plan {
  if (!isPlanId(value)) throw new Error(`Unknown plan: ${String(value)}`);
  return PLANS[value];
}

/**
 * Whether this plan can be bought without a sales conversation.
 *
 * Checked in the controller *and* relied on by the gateway: `enterprise` has no price
 * id, so a checkout for it could only ever fail - better to say why in a 400 than to
 * surface a provider outage that is not one.
 */
export function isSelfServePlan(plan: Plan): boolean {
  return plan.checkout === 'hosted';
}

/** True for a plan the provider will settle at zero, which checkout completes unpaid. */
export function isFreePlan(plan: Plan): boolean {
  return plan.amount === 0;
}

/** `$49.00` from `4900` + `usd`, so the page and the email agree on the wording. */
export function formatAmount(
  amount: number | null,
  currency: string,
): string {
  if (amount === null) return 'Custom';
  if (amount === 0) return 'Free';
  const major = (amount / 100).toFixed(2);
  const symbol = currency.toLowerCase() === 'usd' ? '$' : '';
  return symbol
    ? `${symbol}${major}`
    : `${major} ${currency.toUpperCase()}`;
}

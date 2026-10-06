require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller, Get } = require('@nestjs/common');
const { ROLES } = require('@faultline/auth');
const {
  FEATURES,
  FEATURE_LABELS,
  PLANS,
  planIds,
  clusterLimitFor,
  entitledPlan,
  featuresFor,
  featuresIntroducedBy,
  minimumPlanFor,
  planAllowingClusters,
  planIncludes,
} = require('@faultline/billing');
const { RequiresFeature } = require('../apps/api/dist/auth/context');
const {
  EntitlementsController,
} = require('../apps/api/dist/billing/entitlements.controller');
const {
  ClusterOnboardingController,
} = require('../apps/api/dist/cluster-onboarding.controller');
const {
  ClusterOnboardingService,
} = require('../apps/api/dist/cluster-onboarding.service');
const { CLUSTER_DIRECTORY } = require('../apps/api/dist/clusters.controller');
const {
  apiConfig,
  bootWithRealGuards,
  tokenFor,
} = require('./auth-harness.cjs');

/* ------------------------------------------------------------------ fixtures */

/**
 * Three routes standing in for the three tiers' modules.
 *
 * Deliberately empty handlers: what is under test is whether the request reaches them
 * at all. The modules themselves are elsewhere, or not built yet, and the gate must not
 * care either way - that is the whole point of declaring the requirement on the route.
 */
class ModulesController {
  ledger() {
    return { module: FEATURES.INCIDENT_LEDGER };
  }
  voice() {
    return { module: FEATURES.VOICE_AGENT };
  }
  remediate() {
    return { module: FEATURES.AUTO_REMEDIATION };
  }
}

for (const [method, path, feature] of [
  ['ledger', 'ledger', FEATURES.INCIDENT_LEDGER],
  ['voice', 'voice', FEATURES.VOICE_AGENT],
  ['remediate', 'remediate', FEATURES.AUTO_REMEDIATION],
]) {
  const descriptor = Object.getOwnPropertyDescriptor(
    ModulesController.prototype,
    method,
  );
  Get(path)(ModulesController.prototype, method, descriptor);
  RequiresFeature(feature)(ModulesController.prototype, method, descriptor);
}
Controller('modules')(ModulesController);

const billingOn = () => apiConfig({ billing: { enabled: true } });

const call = (base, token, path) =>
  fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

/**
 * One admin account, optionally holding a subscription.
 *
 * Always an Admin: the point is that the *tier* decides, not the role. If these tests
 * used a restricted role, a pass could be a role check agreeing by accident.
 */
async function boot({
  plan,
  status = 'active',
  endDate,
  cancelAtPeriodEnd = false,
  config = billingOn(),
  clusterCount = 0,
} = {}) {
  const context = await bootWithRealGuards({
    controllers: [ModulesController, EntitlementsController],
    config,
    providers: [
      {
        provide: CLUSTER_DIRECTORY,
        useValue: {
          list: async (_projectIds, organizationId) =>
            Array.from({ length: clusterCount }, (_, index) => ({
              id: `cluster-${index + 1}`,
              organizationId,
            })),
        },
      },
    ],
  });
  const user = await context.users.create({
    email: 'owner@faultline.test',
    name: 'Owner',
    role: ROLES.ADMIN,
    password: 'Correct-horse-battery1!',
  });
  if (plan) {
    const subscription = await context.subscriptions.createForCheckout({
      email: user.email,
      paymentProvider: 'stripe',
      checkoutSessionId: `cs_${plan}_${status}`,
      plan,
      status,
      endDate,
      cancelAtPeriodEnd,
    });
    await context.subscriptions.update(subscription.id, {
      userId: user.id,
      provisioningStatus: 'provisioned',
    });
  }
  return { ...context, user, token: tokenFor(user) };
}

/* ------------------------------------------------------- the catalog itself */

test('a tier carries its own modules and everything below it', () => {
  // Basic: connect a cluster and follow its incidents - nothing else.
  assert.deepEqual(featuresFor('basic'), [
    FEATURES.CLUSTERS,
    FEATURES.CLUSTER_ONBOARDING,
    FEATURES.INCIDENTS,
    FEATURES.ALERTS,
    FEATURES.INCIDENT_LEDGER,
  ]);
  // Pro: every page in the console today, inheriting Basic rather than restating it.
  assert.deepEqual(featuresIntroducedBy('pro'), [
    FEATURES.TEAM_MANAGEMENT,
    FEATURES.INTEGRATIONS,
    FEATURES.LOG_AGGREGATOR,
    FEATURES.REPORTING,
    FEATURES.VOICE_AGENT,
  ]);
  for (const feature of featuresFor('basic')) assert.ok(planIncludes('pro', feature));
  assert.ok(!planIncludes('basic', FEATURES.LOG_AGGREGATOR));
  assert.ok(!planIncludes('pro', FEATURES.AUTO_REMEDIATION));
  // Enterprise: all of it, plus Remediation.
  assert.deepEqual(featuresIntroducedBy('enterprise'), [FEATURES.AUTO_REMEDIATION]);
  assert.equal(featuresFor('enterprise').length, Object.keys(FEATURES).length);

  assert.equal(minimumPlanFor(FEATURES.INCIDENT_LEDGER), 'basic');
  assert.equal(minimumPlanFor(FEATURES.TEAM_MANAGEMENT), 'pro');
  assert.equal(minimumPlanFor(FEATURES.REPORTING), 'pro');
  assert.equal(minimumPlanFor(FEATURES.AUTO_REMEDIATION), 'enterprise');
});

test('Basic may register one cluster and the paid tiers any number', () => {
  assert.equal(clusterLimitFor('basic'), 1);
  assert.equal(clusterLimitFor('pro'), null);
  assert.equal(clusterLimitFor('enterprise'), null);
  // The upgrade a refusal names is the cheapest tier with room for one more.
  assert.equal(planAllowingClusters(0), 'basic');
  assert.equal(planAllowingClusters(1), 'pro');
});

test('an account with no live subscription reads as the free tier, not as nothing', () => {
  assert.equal(entitledPlan(null), 'basic');
  assert.equal(entitledPlan(undefined), 'basic');
  // Downgrade, not eviction: a lapsed Pro keeps the free modules and its history.
  assert.equal(entitledPlan({ plan: 'pro', status: 'canceled' }), 'basic');
  assert.equal(entitledPlan({ plan: 'pro', status: 'past_due' }), 'basic');
  assert.equal(entitledPlan({ plan: 'enterprise', status: 'active' }), 'enterprise');
});

test('the pricing copy names every module its tier introduces', () => {
  // Anti-drift check. The page is prose and the gate is ids; they may be worded
  // differently, but each tier's card must name each module it adds, by the label the
  // console uses, and a higher tier must say it inherits the one below.
  for (const id of planIds) {
    const copy = PLANS[id].features.join(' | ');
    for (const feature of featuresIntroducedBy(id)) {
      const label = FEATURE_LABELS[feature];
      assert.ok(copy.includes(label), `${id} does not mention ${label}`);
    }
    if (id !== 'basic') assert.match(copy, /Everything in /);
  }
});

/* ------------------------------------------------- the gate, over real HTTP */

test('the free tier reaches its own modules and no others', async (t) => {
  const { app, base, token } = await boot({ plan: 'basic' });
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/ledger')).status, 200);

  const denied = await call(base, token, '/modules/voice');
  assert.equal(denied.status, 403);
  const body = await denied.json();
  // The refusal names the upgrade, so the console can offer it rather than guess.
  assert.equal(body.feature, FEATURES.VOICE_AGENT);
  assert.equal(body.plan, 'basic');
  assert.equal(body.requiredPlan, 'pro');
  assert.equal(body.requiredPlanName, 'Pro');
  assert.match(body.message, /Voice Agent is not included in your Basic plan/);

  assert.equal((await call(base, token, '/modules/remediate')).status, 403);
});

test('Pro adds its own modules and still stops short of Enterprise', async (t) => {
  const { app, base, token } = await boot({ plan: 'pro' });
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/ledger')).status, 200);
  assert.equal((await call(base, token, '/modules/voice')).status, 200);

  const denied = await call(base, token, '/modules/remediate');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).requiredPlan, 'enterprise');
});

test('Enterprise reaches every module', async (t) => {
  const { app, base, token } = await boot({ plan: 'enterprise' });
  t.after(() => app.close());

  for (const path of ['/modules/ledger', '/modules/voice', '/modules/remediate'])
    assert.equal((await call(base, token, path)).status, 200, path);
});

test('an account with no subscription at all gets the free tier', async (t) => {
  const { app, base, token } = await boot();
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/ledger')).status, 200);
  assert.equal((await call(base, token, '/modules/voice')).status, 403);
});

test('a cancelled Pro subscription loses the paid modules, not the free ones', async (t) => {
  const { app, base, token } = await boot({ plan: 'pro', status: 'canceled' });
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/ledger')).status, 200);
  assert.equal((await call(base, token, '/modules/voice')).status, 403);
});

test('an Admin is still refused a module their plan does not carry', async (t) => {
  // Role and tier are different questions. Being an Admin buys nothing.
  const { app, base, token, user } = await boot({ plan: 'basic' });
  t.after(() => app.close());

  assert.equal(user.role, ROLES.ADMIN);
  assert.equal((await call(base, token, '/modules/voice')).status, 403);
});

test('a refusal on plan grounds is audited like any other denial', async (t) => {
  const { app, base, token, audit, user } = await boot({ plan: 'basic' });
  t.after(() => app.close());

  await call(base, token, '/modules/voice');

  const entries = await audit.list({});
  const denial = entries.find((entry) => entry.metadata?.check === 'plan');
  assert.ok(denial, 'the attempt is on the record');
  assert.equal(denial.outcome, 'denied');
  assert.equal(denial.userId, user.id);
  assert.equal(denial.resourceType, 'feature');
  assert.equal(denial.resourceId, FEATURES.VOICE_AGENT);
  assert.equal(denial.metadata.required, 'pro');
});

test('an anonymous caller is refused before their plan is ever consulted', async (t) => {
  const { app, base } = await boot({ plan: 'basic' });
  t.after(() => app.close());

  // 401, not 403: a stranger must not learn which tier a module belongs to.
  assert.equal((await call(base, null, '/modules/voice')).status, 401);
});

test('with billing disabled no module is withheld', async (t) => {
  // A self-hosted deployment sells nothing, so nobody holds a subscription. Falling
  // back to the free tier there would silently switch off paid modules for everyone.
  const { app, base, token } = await boot({ config: apiConfig() });
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/voice')).status, 200);
  assert.equal((await call(base, token, '/modules/remediate')).status, 200);
});

/* ----------------------------------------------- what the console is told */

test('the entitlements endpoint reports what the guard enforces', async (t) => {
  const { app, base, token } = await boot({
    plan: 'pro',
    endDate: '2026-12-01T00:00:00.000Z',
    cancelAtPeriodEnd: true,
  });
  t.after(() => app.close());

  const response = await call(base, token, '/billing/entitlements');
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.plan, 'pro');
  assert.equal(body.planName, 'Pro');
  assert.equal(body.enforced, true);
  assert.equal(body.subscriptionStatus, 'active');
  assert.equal(body.subscriptionPeriodEnd, '2026-12-01T00:00:00.000Z');
  assert.equal(body.cancelAtPeriodEnd, true);
  assert.deepEqual(body.limits, { clusters: null });
  assert.deepEqual(body.usage, { clusters: 0 });
  assert.deepEqual(
    body.features.map((entry) => entry.id).sort(),
    [...featuresFor('pro')].sort(),
  );
  assert.deepEqual(body.locked, [
    {
      id: FEATURES.AUTO_REMEDIATION,
      label: 'Remediation',
      requiredPlan: 'enterprise',
      requiredPlanName: 'Enterprise',
    },
  ]);
  // It answers "what may I use", so the billing relationship stays out of it.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('cs_'), 'no checkout session id');
  assert.ok(!serialized.includes('cus_'), 'no provider customer id');
});

test('the entitlements endpoint says so when tiers are not enforced', async (t) => {
  const { app, base, token } = await boot({ config: apiConfig() });
  t.after(() => app.close());

  const body = await (await call(base, token, '/billing/entitlements')).json();
  assert.equal(body.enforced, false);
  assert.equal(body.locked.length, 0);
  assert.equal(body.features.length, Object.keys(FEATURES).length);
  assert.deepEqual(body.limits, { clusters: null });
  assert.deepEqual(body.usage, { clusters: 0 });
});

test('entitlements are not readable without a token', async (t) => {
  const { app, base } = await boot({ plan: 'pro' });
  t.after(() => app.close());

  assert.equal((await call(base, null, '/billing/entitlements')).status, 401);
});

test('the free tier is told its cluster allowance, usage and which pages are locked', async (t) => {
  const { app, base, token } = await boot({ plan: 'basic', clusterCount: 1 });
  t.after(() => app.close());

  const body = await (await call(base, token, '/billing/entitlements')).json();
  assert.equal(body.plan, 'basic');
  assert.deepEqual(body.limits, { clusters: 1 });
  assert.deepEqual(body.usage, { clusters: 1 });
  assert.deepEqual(
    body.locked.filter((entry) => entry.requiredPlan === 'pro').map((entry) => entry.label),
    ['Team & Roles', 'Integrations', 'Runtime', 'Reports', 'Voice Agent'],
  );
});

/* -------------------------------------- the plan belongs to the organization */

/** An engineer created by an Admin: no subscription of their own. */
async function engineerIn(context, organizationId) {
  const engineer = await context.users.create({
    email: `engineer-${organizationId}@faultline.test`,
    name: 'Engineer',
    role: ROLES.ONSITE_ENGINEER,
    password: 'Correct-horse-battery1!',
    organizationId,
  });
  return tokenFor(engineer);
}

test('an engineer works under the plan their organization owner bought', async (t) => {
  const context = await boot({ plan: 'pro' });
  t.after(() => context.app.close());

  const token = await engineerIn(context, context.user.organizationId);
  assert.equal((await call(context.base, token, '/modules/voice')).status, 200);
  const body = await (await call(context.base, token, '/billing/entitlements')).json();
  assert.equal(body.plan, 'pro');
  assert.equal(body.subscriptionStatus, 'active');
});

test('another organization\'s subscription buys an engineer nothing', async (t) => {
  const context = await boot({ plan: 'enterprise' });
  t.after(() => context.app.close());

  const token = await engineerIn(context, 'another-organization');
  const denied = await call(context.base, token, '/modules/voice');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).plan, 'basic');
});

/* ------------------------------------------------------- the cluster allowance */

/** Onboarding over real HTTP, with the organization already holding `existing` clusters. */
async function bootOnboarding({ plan, existing, config = billingOn() }) {
  const started = [];
  const context = await bootWithRealGuards({
    controllers: [ClusterOnboardingController],
    providers: [
      {
        provide: ClusterOnboardingService,
        useValue: {
          start: (...args) => {
            started.push(args);
            return { id: 'job-1', status: 'running' };
          },
        },
      },
      {
        provide: CLUSTER_DIRECTORY,
        useValue: {
          list: async (projectIds, organizationId) =>
            Array.from({ length: existing }, (_, index) => ({ id: `cluster-${index}`, organizationId })),
        },
      },
    ],
    config,
  });
  const owner = await context.users.create({
    email: 'owner@faultline.test',
    name: 'Owner',
    role: ROLES.ADMIN,
    password: 'Correct-horse-battery1!',
  });
  if (plan) {
    const subscription = await context.subscriptions.createForCheckout({
      email: owner.email,
      paymentProvider: 'stripe',
      checkoutSessionId: `cs_${plan}_onboarding`,
      plan,
      status: 'active',
    });
    await context.subscriptions.update(subscription.id, { userId: owner.id });
  }
  const onboard = () =>
    fetch(`${context.base}/cluster-onboarding`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(owner)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clusterName: 'Production', controlPlaneIp: '10.0.0.8' }),
    });
  return { ...context, started, onboard };
}

test('Basic onboards its first cluster', async (t) => {
  const { app, onboard, started } = await bootOnboarding({ plan: 'basic', existing: 0 });
  t.after(() => app.close());

  assert.equal((await onboard()).status, 202);
  assert.equal(started.length, 1);
});

test('Basic is refused a second cluster before anything is installed', async (t) => {
  const { app, onboard, started } = await bootOnboarding({ plan: 'basic', existing: 1 });
  t.after(() => app.close());

  const refused = await onboard();
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.plan, 'basic');
  assert.equal(body.requiredPlan, 'pro');
  assert.deepEqual(body.limit, { clusters: 1, used: 1 });
  assert.match(body.message, /includes 1 cluster/);
  // The job never started, so no collector reached the cluster.
  assert.equal(started.length, 0);
});

test('Pro onboards past the free allowance', async (t) => {
  const { app, onboard } = await bootOnboarding({ plan: 'pro', existing: 3 });
  t.after(() => app.close());

  assert.equal((await onboard()).status, 202);
});

test('with billing disabled the cluster allowance is not enforced', async (t) => {
  const { app, onboard } = await bootOnboarding({ existing: 5, config: apiConfig() });
  t.after(() => app.close());

  assert.equal((await onboard()).status, 202);
});

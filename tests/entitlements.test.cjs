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
  entitledPlan,
  featuresFor,
  minimumPlanFor,
  planIncludes,
} = require('@faultline/billing');
const { RequiresFeature } = require('../apps/api/dist/auth/context');
const {
  EntitlementsController,
} = require('../apps/api/dist/billing/entitlements.controller');
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
  logs() {
    return { module: FEATURES.LOG_AGGREGATOR };
  }
  voice() {
    return { module: FEATURES.VOICE_AGENT };
  }
  remediate() {
    return { module: FEATURES.AUTO_REMEDIATION };
  }
}

for (const [method, path, feature] of [
  ['logs', 'logs', FEATURES.LOG_AGGREGATOR],
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
async function boot({ plan, status = 'active', config = billingOn() } = {}) {
  const context = await bootWithRealGuards({
    controllers: [ModulesController, EntitlementsController],
    config,
  });
  const user = await context.users.create({
    email: 'owner@faultline.test',
    name: 'Owner',
    role: ROLES.ADMIN,
    password: 'correct-horse-battery',
  });
  if (plan) {
    const subscription = await context.subscriptions.createForCheckout({
      email: user.email,
      paymentProvider: 'stripe',
      checkoutSessionId: `cs_${plan}_${status}`,
      plan,
      status,
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
  assert.deepEqual(featuresFor('basic'), [
    FEATURES.LOG_AGGREGATOR,
    FEATURES.INCIDENT_LEDGER,
  ]);
  // Pro inherits the free modules rather than restating them, and Enterprise inherits
  // both - a module added to Basic later cannot be withheld from the tiers above it.
  assert.ok(planIncludes('pro', FEATURES.LOG_AGGREGATOR));
  assert.ok(planIncludes('pro', FEATURES.VOICE_AGENT));
  assert.ok(planIncludes('pro', FEATURES.REPORTING));
  assert.ok(!planIncludes('pro', FEATURES.AUTO_REMEDIATION));
  assert.equal(featuresFor('enterprise').length, Object.keys(FEATURES).length);

  assert.equal(minimumPlanFor(FEATURES.INCIDENT_LEDGER), 'basic');
  assert.equal(minimumPlanFor(FEATURES.REPORTING), 'pro');
  assert.equal(minimumPlanFor(FEATURES.AUTO_REMEDIATION), 'enterprise');
});

test('an account with no live subscription reads as the free tier, not as nothing', () => {
  assert.equal(entitledPlan(null), 'basic');
  assert.equal(entitledPlan(undefined), 'basic');
  // Downgrade, not eviction: a lapsed Pro keeps the free modules and its history.
  assert.equal(entitledPlan({ plan: 'pro', status: 'canceled' }), 'basic');
  assert.equal(entitledPlan({ plan: 'pro', status: 'past_due' }), 'basic');
  assert.equal(entitledPlan({ plan: 'enterprise', status: 'active' }), 'enterprise');
});

test('the pricing copy names the modules its tier actually unlocks', () => {
  // Cheap anti-drift check. The page is prose and the gate is ids; they are allowed to
  // be worded differently, but a tier must not advertise a module it does not carry.
  for (const id of planIds) {
    const copy = PLANS[id].features.join(' | ');
    for (const feature of featuresFor(id)) {
      const label = FEATURE_LABELS[feature];
      const named =
        copy.includes(label) ||
        // ...or inherited explicitly, which is how the higher tiers say it.
        copy.includes('Everything in');
      assert.ok(named, `${id} does not mention ${label}`);
    }
  }
});

/* ------------------------------------------------- the gate, over real HTTP */

test('the free tier reaches its own modules and no others', async (t) => {
  const { app, base, token } = await boot({ plan: 'basic' });
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/logs')).status, 200);

  const denied = await call(base, token, '/modules/voice');
  assert.equal(denied.status, 403);
  const body = await denied.json();
  // The refusal names the upgrade, so the console can offer it rather than guess.
  assert.equal(body.feature, FEATURES.VOICE_AGENT);
  assert.equal(body.plan, 'basic');
  assert.equal(body.requiredPlan, 'pro');
  assert.equal(body.requiredPlanName, 'Pro');
  assert.match(body.message, /Voice Call Agent/);

  assert.equal((await call(base, token, '/modules/remediate')).status, 403);
});

test('Pro adds its own modules and still stops short of Enterprise', async (t) => {
  const { app, base, token } = await boot({ plan: 'pro' });
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/logs')).status, 200);
  assert.equal((await call(base, token, '/modules/voice')).status, 200);

  const denied = await call(base, token, '/modules/remediate');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).requiredPlan, 'enterprise');
});

test('Enterprise reaches every module', async (t) => {
  const { app, base, token } = await boot({ plan: 'enterprise' });
  t.after(() => app.close());

  for (const path of ['/modules/logs', '/modules/voice', '/modules/remediate'])
    assert.equal((await call(base, token, path)).status, 200, path);
});

test('an account with no subscription at all gets the free tier', async (t) => {
  const { app, base, token } = await boot();
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/logs')).status, 200);
  assert.equal((await call(base, token, '/modules/voice')).status, 403);
});

test('a cancelled Pro subscription loses the paid modules, not the free ones', async (t) => {
  const { app, base, token } = await boot({ plan: 'pro', status: 'canceled' });
  t.after(() => app.close());

  assert.equal((await call(base, token, '/modules/logs')).status, 200);
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
  const { app, base, token } = await boot({ plan: 'pro' });
  t.after(() => app.close());

  const response = await call(base, token, '/billing/entitlements');
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.plan, 'pro');
  assert.equal(body.planName, 'Pro');
  assert.equal(body.enforced, true);
  assert.equal(body.subscriptionStatus, 'active');
  assert.deepEqual(
    body.features.map((entry) => entry.id).sort(),
    [...featuresFor('pro')].sort(),
  );
  assert.deepEqual(body.locked, [
    {
      id: FEATURES.AUTO_REMEDIATION,
      label: 'Auto Remediation',
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
});

test('entitlements are not readable without a token', async (t) => {
  const { app, base } = await boot({ plan: 'pro' });
  t.after(() => app.close());

  assert.equal((await call(base, null, '/billing/entitlements')).status, 401);
});

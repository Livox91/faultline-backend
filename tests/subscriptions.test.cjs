require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ROLES,
  InMemoryUserRepository,
  InMemoryAuditLogRepository,
  InMemoryProjectAssignmentRepository,
  AUDIT_LOG_REPOSITORY,
  USER_REPOSITORY,
  PROJECT_ASSIGNMENT_REPOSITORY,
  generateTemporaryPassword,
  allocateUsername,
  usernameCandidate,
  isValidUsername,
  verifyPassword,
} = require('@faultline/auth');
const {
  InMemorySubscriptionRepository,
  InMemoryProcessedEventRepository,
  SUBSCRIPTION_REPOSITORY,
  PROCESSED_EVENT_REPOSITORY,
  PLANS,
} = require('@faultline/billing');
const { RecordingEmailSender, EMAIL_SENDER } = require('@faultline/email');
const { APPLICATION_CONFIG, ApplicationLogger } = require('@faultline/platform');
const {
  SubscriptionProvisioningService,
} = require('../apps/api/dist/billing/provisioning.service');
const {
  BillingController,
} = require('../apps/api/dist/billing/billing.controller');
const { PAYMENT_GATEWAY } = require('../apps/api/dist/billing/stripe.gateway');
const { AuditTrail } = require('../apps/api/dist/auth/audit-trail');
const { AuthController, LoginThrottle } = require('../apps/api/dist/auth/auth.controller');
const { ClustersController, CLUSTER_DIRECTORY } = require('../apps/api/dist/clusters.controller');
const { AdminUsersController } = require('../apps/api/dist/auth/users.controller');
const { apiConfig, bootWithRealGuards, silentLogger } = require('./auth-harness.cjs');

/* ------------------------------------------------------------------ fixtures */

const PURCHASER = 'buyer@example.com';

const config = {
  ...apiConfig(),
  applicationName: 'Faultline',
  publicUrl: 'https://app.faultline.test',
  billing: {
    enabled: true,
    provider: 'stripe',
    priceIds: { basic: 'price_test_basic', pro: 'price_test' },
    salesContact: 'sales@faultline.test',
  },
  email: { transport: 'log', from: 'Faultline <no-reply@faultline.test>' },
};

const payment = (overrides = {}) => ({
  checkoutSessionId: 'cs_test_1',
  email: PURCHASER,
  plan: 'pro',
  status: 'active',
  customerId: 'cus_test_1',
  subscriptionId: 'sub_test_1',
  requestedUsername: null,
  fullName: 'Jane Buyer',
  startDate: '2026-09-20T00:00:00.000Z',
  ...overrides,
});

/** Builds the provisioning service over in-memory storage. */
function provisioner() {
  const users = new InMemoryUserRepository();
  const subscriptions = new InMemorySubscriptionRepository();
  const audit = new InMemoryAuditLogRepository();
  const email = new RecordingEmailSender();
  const service = new SubscriptionProvisioningService(
    users,
    subscriptions,
    email,
    config,
    new AuditTrail(audit, silentLogger),
    silentLogger,
  );
  return { service, users, subscriptions, audit, email };
}

/* -------------------------------------------------- credential generation */

test('temporary passwords are random, long, and drawn from four character classes', () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const password = generateTemporaryPassword();
    assert.equal(password.length, 16);
    assert.match(password, /[a-z]/, 'has a lowercase letter');
    assert.match(password, /[A-Z]/, 'has an uppercase letter');
    assert.match(password, /[2-9]/, 'has a digit');
    assert.match(password, /[!@#$%^&*?]/, 'has a symbol');
    // Characters that cannot be told apart when read off a screen are excluded.
    assert.doesNotMatch(password, /[lI1O0]/);
    seen.add(password);
  }
  // 200 draws from a ~96-bit space: a repeat would mean the source is not random.
  assert.equal(seen.size, 200, 'every generated password is distinct');
  assert.throws(() => generateTemporaryPassword(8), /at least 12/);
});

test('usernames are derived, validated and made unique without a sequential counter', async () => {
  assert.equal(usernameCandidate('John Smith'), 'john.smith');
  assert.equal(usernameCandidate('José Pérez'), 'jose.perez', 'diacritics fold');
  assert.equal(usernameCandidate('!!'), 'admin', 'unusable input falls back');
  assert.equal(isValidUsername('john.smith'), true);
  assert.equal(isValidUsername('ab'), false, 'too short');
  assert.equal(isValidUsername('has space'), false);

  const taken = new Set(['john.smith']);
  const allocated = await allocateUsername('John Smith', async (candidate) =>
    taken.has(candidate),
  );
  assert.notEqual(allocated, 'john.smith');
  assert.match(allocated, /^john\.smith\d+$/);
  // Not `john.smith2`: a sequential suffix would advertise how many accounts exist.
  assert.notEqual(allocated, 'john.smith2');
  assert.equal(isValidUsername(allocated), true);
});

/* --------------------------------------------------------- provisioning */

test('a confirmed payment creates exactly one admin, locked to a password change', async () => {
  const { service, users, subscriptions, email } = provisioner();

  const outcome = await service.provision(payment());
  assert.equal(outcome.kind, 'provisioned');

  const created = await users.findByEmail(PURCHASER);
  assert.ok(created, 'the admin account exists');
  assert.equal(created.role, ROLES.ADMIN, 'purchasers become admins');
  assert.equal(created.status, 'active');
  assert.equal(created.mustChangePassword, true, 'confined until they choose one');
  assert.equal(created.username, outcome.username);
  assert.equal(created.name, 'Jane Buyer');

  // The stored credential is a salted scrypt hash, never the plaintext.
  assert.ok(created.passwordHash.startsWith('scrypt$'));
  const message = email.lastTo(PURCHASER);
  assert.ok(message, 'credentials were emailed');
  assert.ok(
    !created.passwordHash.includes(message.text.match(/Temporary Password: (\S+)/)[1]),
    'the database holds a hash, not the temporary password',
  );

  const subscription = await subscriptions.findByCheckoutSession('cs_test_1');
  assert.equal(subscription.userId, created.id, 'subscription is linked to the user');
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.provisioningStatus, 'provisioned');
  assert.equal(subscription.plan, 'pro');
  assert.equal(subscription.paymentProviderSubscriptionId, 'sub_test_1');
});

test('the credentials email carries the username, the temporary password and a login link', async () => {
  const { service, email, users } = provisioner();
  const outcome = await service.provision(payment());
  const created = await users.findByEmail(PURCHASER);

  const message = email.lastTo(PURCHASER);
  assert.equal(message.to, PURCHASER);
  assert.match(message.subject, /admin account/i);
  assert.ok(message.text.includes(outcome.username), 'includes the username');
  assert.ok(
    message.text.includes('https://app.faultline.test/login'),
    'includes the login link built from APP_PUBLIC_URL',
  );
  assert.match(message.text, /must change your temporary password/i);
  assert.ok(message.text.includes(PLANS.pro.name), 'names the plan');

  // The password in the email is the one that actually opens the account.
  const temporary = message.text.match(/Temporary Password: (\S+)/)[1];
  assert.equal(await verifyPassword(temporary, created.passwordHash), true);
  assert.ok(message.html.includes(outcome.username));
});

test('a redelivered payment event does not create a second admin', async () => {
  const { service, users, subscriptions, email } = provisioner();

  const first = await service.provision(payment());
  const second = await service.provision(payment());
  const third = await service.provision(payment());

  assert.equal(first.kind, 'provisioned');
  assert.equal(second.kind, 'already-provisioned');
  assert.equal(third.kind, 'already-provisioned');

  assert.equal((await users.list()).length, 1, 'exactly one account exists');
  assert.equal(
    (await subscriptions.listUnprovisioned()).length,
    0,
    'the one subscription is fully provisioned',
  );
  assert.equal(
    email.sent.length,
    1,
    'credentials are emailed once, not once per delivery',
  );
});

test('paying with the email of an existing account links the subscription and changes nothing else', async () => {
  const { service, users, subscriptions, email } = provisioner();

  // An Onsite Engineer who is deliberately restricted to their own projects.
  const engineer = await users.create({
    email: PURCHASER,
    name: 'Existing Engineer',
    role: ROLES.ONSITE_ENGINEER,
    password: 'their-own-password',
    username: 'existing.engineer',
  });

  const outcome = await service.provision(payment());
  assert.equal(outcome.kind, 'linked-existing-user');

  const after = await users.findById(engineer.id);
  // This is the important one: buying a subscription with someone's email address must
  // not hand out Admin. Otherwise checkout is a privilege-escalation tool.
  assert.equal(after.role, ROLES.ONSITE_ENGINEER, 'the role is untouched');
  assert.equal(after.mustChangePassword, false, 'their password is untouched');
  assert.equal(
    await verifyPassword('their-own-password', after.passwordHash),
    true,
    'the existing password still works',
  );
  assert.equal((await users.list()).length, 1, 'no duplicate account was created');
  assert.equal(email.sent.length, 0, 'no credentials were emailed to an existing user');

  const subscription = await subscriptions.findByCheckoutSession('cs_test_1');
  assert.equal(subscription.userId, engineer.id, 'the payment is still recorded');
  assert.equal(subscription.provisioningStatus, 'provisioned');
});

test('a failed credentials email keeps the account and flags the subscription for retry', async () => {
  const users = new InMemoryUserRepository();
  const subscriptions = new InMemorySubscriptionRepository();
  const audit = new InMemoryAuditLogRepository();
  const brokenEmail = {
    name: 'broken',
    send: async () => {
      throw new Error('smtp unavailable');
    },
  };
  const service = new SubscriptionProvisioningService(
    users,
    subscriptions,
    brokenEmail,
    config,
    new AuditTrail(audit, silentLogger),
    silentLogger,
  );

  const outcome = await service.provision(payment());
  assert.equal(outcome.kind, 'email-failed');

  // The payment is not lost and the account is not half-made: both exist, and the
  // subscription says exactly what still needs doing.
  const created = await users.findByEmail(PURCHASER);
  assert.ok(created, 'the admin account survives a delivery failure');
  const subscription = await subscriptions.findByCheckoutSession('cs_test_1');
  assert.equal(subscription.provisioningStatus, 'email_failed');
  assert.match(subscription.provisioningError, /smtp unavailable/);
  assert.equal(subscription.userId, created.id);

  const outstanding = await subscriptions.listUnprovisioned();
  assert.equal(outstanding.length, 1, 'reconciliation can find it');
});

test('a purchaser keeps the username they asked for, unless it is taken', async () => {
  const { service, users } = provisioner();

  const first = await service.provision(
    payment({ requestedUsername: 'janebuyer' }),
  );
  assert.equal(first.username, 'janebuyer');

  const second = await service.provision(
    payment({
      checkoutSessionId: 'cs_test_2',
      email: 'other@example.com',
      requestedUsername: 'janebuyer',
    }),
  );
  assert.notEqual(second.username, 'janebuyer', 'the second purchaser gets a free one');
  assert.equal((await users.findByUsername(second.username)).email, 'other@example.com');
});

/* ------------------------------------------------- webhook and idempotency */

/** A gateway double: the controller's contract without a network call. */
function fakeGateway(overrides = {}) {
  return {
    provider: 'stripe',
    createCheckoutSession: async () => ({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.test/cs_test_1',
    }),
    verifyWebhook: (_payload, signature) => {
      if (signature !== 'good') throw new Error('bad signature');
      return { id: 'evt_1', type: 'checkout.session.completed', payment: payment() };
    },
    getCheckoutStatus: async () => ({ paid: true, email: PURCHASER }),
    ...overrides,
  };
}

function billingController(gateway = fakeGateway()) {
  const context = provisioner();
  const events = new InMemoryProcessedEventRepository();
  const controller = new BillingController(
    gateway,
    events,
    config,
    context.service,
    silentLogger,
  );
  return { controller, events, ...context };
}

const rawRequest = (signature) => ({
  headers: { 'stripe-signature': signature },
  rawBody: Buffer.from('{}'),
});

test('an unsigned or wrongly signed webhook creates nothing', async () => {
  const { controller, users } = billingController();

  await assert.rejects(
    controller.webhook(rawRequest('forged')),
    (error) => error.getStatus() === 401,
    'a bad signature is rejected',
  );
  await assert.rejects(
    controller.webhook({ headers: {}, rawBody: Buffer.from('{}') }),
    (error) => error.getStatus() === 401,
    'a missing signature is rejected',
  );
  assert.equal((await users.list()).length, 0, 'no account was created');
});

test('the same webhook event delivered twice provisions once', async () => {
  const { controller, users, email } = billingController();

  const first = await controller.webhook(rawRequest('good'));
  const second = await controller.webhook(rawRequest('good'));

  assert.deepEqual(first, { received: true, handled: true, outcome: 'provisioned' });
  assert.deepEqual(second, { received: true, duplicate: true });
  assert.equal((await users.list()).length, 1);
  assert.equal(email.sent.length, 1);
});

test('an unpaid or irrelevant event is acknowledged without provisioning', async () => {
  // Stripe fires checkout.session.completed for sessions that never paid; the gateway
  // returns no payment for those, and the controller must not invent one.
  const unpaid = billingController(
    fakeGateway({
      verifyWebhook: () => ({ id: 'evt_unpaid', type: 'checkout.session.completed' }),
    }),
  );
  const answer = await unpaid.controller.webhook(rawRequest('good'));
  assert.deepEqual(answer, { received: true, handled: false });
  assert.equal((await unpaid.users.list()).length, 0);

  const cancelled = billingController(
    fakeGateway({
      verifyWebhook: () => ({ id: 'evt_cancel', type: 'customer.subscription.deleted' }),
    }),
  );
  assert.deepEqual(await cancelled.controller.webhook(rawRequest('good')), {
    received: true,
    handled: false,
  });
  assert.equal((await cancelled.users.list()).length, 0);
});

test('a provisioning failure releases the event so the provider retry can succeed', async () => {
  let failures = 1;
  const { controller, users, email } = billingController();
  const original = controller.provisioning.provision.bind(controller.provisioning);
  controller.provisioning.provision = async (input) => {
    if (failures-- > 0) throw new Error('database briefly unavailable');
    return original(input);
  };

  await assert.rejects(
    controller.webhook(rawRequest('good')),
    /database briefly unavailable/,
  );
  assert.equal((await users.list()).length, 0);

  // The retry is allowed to do real work: a transient failure must not mark the event
  // permanently handled and strand a paying customer.
  const retry = await controller.webhook(rawRequest('good'));
  assert.equal(retry.outcome, 'provisioned');
  assert.equal((await users.list()).length, 1);
  assert.equal(email.sent.length, 1);
});

test('checkout validates its input and never creates an account by itself', async () => {
  const { controller, users } = billingController();

  await assert.rejects(
    controller.checkout({ email: 'not-an-email' }),
    (error) => error.getStatus() === 400,
  );
  await assert.rejects(
    controller.checkout({ email: PURCHASER, plan: 'enterprise' }),
    (error) => error.getStatus() === 400,
  );
  await assert.rejects(
    controller.checkout({ email: PURCHASER, username: 'no' }),
    (error) => error.getStatus() === 400,
  );

  const session = await controller.checkout({ email: PURCHASER, plan: 'pro' });
  assert.match(session.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
  // Opening a checkout is not a purchase: nothing exists until the webhook confirms.
  assert.equal((await users.list()).length, 0, 'no account before payment');
});

test('the public plans endpoint exposes every tier, its pricing, and no secrets', () => {
  const { controller } = billingController();
  const body = controller.plans();
  assert.equal(body.applicationName, 'Faultline');
  assert.deepEqual(
    body.plans.map((plan) => plan.id),
    ['basic', 'pro', 'enterprise'],
  );

  const byId = Object.fromEntries(body.plans.map((plan) => [plan.id, plan]));
  assert.equal(byId.basic.priceLabel, 'Free');
  assert.equal(byId.pro.priceLabel, '$49.00');
  // Enterprise is listed but has no list price, and says so rather than showing a zero.
  assert.equal(byId.enterprise.priceLabel, 'Custom');
  assert.equal(byId.enterprise.checkout, 'contact');
  assert.equal(body.salesContact, 'sales@faultline.test');
  // Exactly one tier is led with, so the page cannot render two 'recommended' badges.
  assert.equal(body.plans.filter((plan) => plan.recommended).length, 1);
  for (const plan of body.plans) assert.ok(plan.features.length > 0, plan.id);

  assert.ok(!JSON.stringify(body).includes('price_test'), 'no provider price ids');
  assert.ok(!JSON.stringify(body).includes('secret'), 'no secrets');
});

/* ------------------------------------ first login, confinement, and release */

/** Boots the API surface with the real guards, over the provisioner's storage. */
async function bootApi(context) {
  return bootWithRealGuards({
    controllers: [AuthController, ClustersController, AdminUsersController],
    providers: [
      LoginThrottle,
      { provide: CLUSTER_DIRECTORY, useValue: { list: async () => [], get: async () => undefined } },
    ],
    users: context.users,
    audit: context.audit,
    config,
  });
}

const call = (base, token, path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

const login = (base, body) =>
  fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the emailed credentials sign in, and the account is then locked to the password change', async () => {
  const context = provisioner();
  const outcome = await context.service.provision(payment());
  const temporary = context.email
    .lastTo(PURCHASER)
    .text.match(/Temporary Password: (\S+)/)[1];

  const { app, base } = await bootApi(context);
  try {
    // The emailed username works, and so does the email address.
    const byUsername = await login(base, {
      username: outcome.username,
      password: temporary,
    });
    assert.equal(byUsername.status, 200);
    const session = await byUsername.json();
    assert.equal(session.user.role, ROLES.ADMIN);
    assert.equal(session.user.mustChangePassword, true);
    assert.equal(session.user.username, outcome.username);

    const byEmail = await login(base, { email: PURCHASER, password: temporary });
    assert.equal(byEmail.status, 200);

    const token = session.accessToken;

    // Step 8: nothing protected is reachable, by URL or by direct API call, even
    // though this is a fully authenticated Admin token.
    for (const [method, path] of [
      ['GET', '/projects'],
      ['GET', '/clusters'],
      ['GET', '/admin/users'],
      ['POST', '/projects'],
    ]) {
      const response = await call(base, token, path, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify({ id: 'x', name: 'x' }) } : {}),
      });
      assert.equal(
        response.status,
        403,
        `${method} ${path} must be refused while a password change is pending`,
      );
      assert.match((await response.json()).message, /change your temporary password/i);
    }

    // But the routes needed to get out of that state do work.
    assert.equal((await call(base, token, '/auth/me')).status, 200);
    assert.equal(
      (await call(base, token, '/auth/logout', { method: 'POST' })).status,
      204,
    );
  } finally {
    await app.close();
  }
});

test('changing the password lifts the lock and retires the temporary credential', async () => {
  const context = provisioner();
  await context.service.provision(payment());
  const temporary = context.email
    .lastTo(PURCHASER)
    .text.match(/Temporary Password: (\S+)/)[1];

  const { app, base } = await bootApi(context);
  try {
    const token = (await (await login(base, { email: PURCHASER, password: temporary })).json())
      .accessToken;

    const change = (body) =>
      call(base, token, '/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(body),
      });

    // The current password is required even though the caller holds a valid token.
    assert.equal(
      (await change({ currentPassword: 'wrong-password', newPassword: 'a-brand-new-secret' }))
        .status,
      401,
    );
    assert.equal(
      (await change({ currentPassword: temporary, newPassword: 'short' })).status,
      400,
      'the new password must meet the length floor',
    );
    assert.equal(
      (await change({ currentPassword: temporary, newPassword: temporary })).status,
      400,
      'the new password must actually differ',
    );

    const success = await change({
      currentPassword: temporary,
      newPassword: 'a-brand-new-secret',
    });
    assert.equal(success.status, 200);
    const refreshed = await success.json();
    assert.equal(refreshed.user.mustChangePassword, false);
    assert.ok(refreshed.accessToken, 'the session is refreshed');

    // Stored as a hash, and the old credential is dead.
    const stored = await context.users.findByEmail(PURCHASER);
    assert.equal(stored.mustChangePassword, false);
    assert.ok(stored.passwordHash.startsWith('scrypt$'));
    assert.equal(await verifyPassword('a-brand-new-secret', stored.passwordHash), true);
    assert.equal(
      await verifyPassword(temporary, stored.passwordHash),
      false,
      'the temporary password no longer verifies',
    );
    assert.equal(
      (await login(base, { email: PURCHASER, password: temporary })).status,
      401,
      'and no longer signs in',
    );

    // Step 10: normal Admin access, on the refreshed token and the original one alike.
    assert.equal((await call(base, refreshed.accessToken, '/projects')).status, 200);
    assert.equal((await call(base, refreshed.accessToken, '/admin/users')).status, 200);
    assert.equal(
      (await call(base, token, '/projects')).status,
      200,
      'the lock is read from storage, so the pre-change token is freed too',
    );
  } finally {
    await app.close();
  }
});

test('the existing RBAC is untouched: an engineer is still confined to their projects', async () => {
  const context = provisioner();
  await context.service.provision(payment());

  const engineer = await context.users.create({
    email: 'ahmed@example.com',
    name: 'Ahmed',
    role: ROLES.ONSITE_ENGINEER,
    password: 'engineer-password-1',
  });
  const assignments = new InMemoryProjectAssignmentRepository();
  await assignments.assign(engineer.id, 'project-a', engineer.id, []);

  const { app, base } = await bootWithRealGuards({
    controllers: [AuthController, ClustersController, AdminUsersController],
    providers: [
      LoginThrottle,
      {
        provide: CLUSTER_DIRECTORY,
        useValue: {
          list: async (ids) =>
            [{ id: 'project-a' }, { id: 'project-b' }].filter(
              (p) => !ids || ids.includes(p.id),
            ),
          get: async (id) => ({ id }),
        },
      },
    ],
    users: context.users,
    assignments,
    audit: context.audit,
    config,
  });
  try {
    const token = (
      await (
        await login(base, { email: 'ahmed@example.com', password: 'engineer-password-1' })
      ).json()
    ).accessToken;

    // An engineer never had mustChangePassword set, so they are not confined...
    const projects = await call(base, token, '/projects');
    assert.equal(projects.status, 200);
    assert.deepEqual(
      (await projects.json()).map((p) => p.id),
      ['project-a'],
      'still sees only assigned projects',
    );
    // ...and the pre-existing restrictions still apply.
    assert.equal((await call(base, token, '/projects/project-b')).status, 403);
    assert.equal((await call(base, token, '/admin/users')).status, 403);
  } finally {
    await app.close();
  }
});

test('the real Stripe gateway accepts only genuinely signed payloads', () => {
  const Stripe = require('stripe');
  const { StripeGateway } = require('../apps/api/dist/billing/stripe.gateway');

  const webhookSecret = 'whsec_test_secret_value';
  const gateway = new StripeGateway({
    ...config,
    billing: { ...config.billing, secretKey: 'sk_test_x', webhookSecret },
  });

  const session = {
    id: 'cs_live_1',
    object: 'checkout.session',
    payment_status: 'paid',
    customer: 'cus_1',
    subscription: 'sub_1',
    customer_email: PURCHASER,
    customer_details: { email: PURCHASER, name: 'Jane Buyer' },
    metadata: { plan: 'pro', requestedUsername: 'janebuyer' },
    created: 1789900000,
  };
  const body = JSON.stringify({
    id: 'evt_live_1',
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: session },
  });
  const payload = Buffer.from(body);

  // Stripe's own helper produces the header a real delivery would carry.
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: webhookSecret,
  });

  const event = gateway.verifyWebhook(payload, signature);
  assert.equal(event.id, 'evt_live_1');
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.payment.email, PURCHASER);
  assert.equal(event.payment.plan, 'pro');
  assert.equal(event.payment.checkoutSessionId, 'cs_live_1');
  assert.equal(event.payment.requestedUsername, 'janebuyer');
  assert.equal(event.payment.subscriptionId, 'sub_1');

  // A signature made with a different secret, and a payload altered after signing,
  // are both refused - the second is what a tampered "make me an admin" would be.
  assert.throws(
    () =>
      gateway.verifyWebhook(
        payload,
        Stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: 'whsec_wrong_secret_value',
        }),
      ),
    /signature/i,
  );
  assert.throws(
    () =>
      gateway.verifyWebhook(
        Buffer.from(body.replace(PURCHASER, 'attacker@evil.test')),
        signature,
      ),
    /signature/i,
  );

  // An unpaid session carries no payment, so provisioning is never reached.
  const unpaidBody = JSON.stringify({
    id: 'evt_live_2',
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { ...session, payment_status: 'unpaid' } },
  });
  const unpaid = gateway.verifyWebhook(
    Buffer.from(unpaidBody),
    Stripe.webhooks.generateTestHeaderString({
      payload: unpaidBody,
      secret: webhookSecret,
    }),
  );
  assert.equal(unpaid.payment, undefined, 'an unpaid session provisions nothing');
});

test('a zero-amount tier settles without payment, and only that tier may', () => {
  const Stripe = require('stripe');
  const { StripeGateway } = require('../apps/api/dist/billing/stripe.gateway');

  const webhookSecret = 'whsec_test_secret_value';
  const gateway = new StripeGateway({
    ...config,
    billing: { ...config.billing, secretKey: 'sk_test_x', webhookSecret },
  });

  const signed = (session, id) => {
    const body = JSON.stringify({
      id,
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: session },
    });
    return gateway.verifyWebhook(
      Buffer.from(body),
      Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret }),
    );
  };

  const base = {
    id: 'cs_live_free',
    object: 'checkout.session',
    payment_status: 'no_payment_required',
    customer: 'cus_2',
    subscription: 'sub_2',
    customer_email: PURCHASER,
    customer_details: { email: PURCHASER, name: 'Jane Buyer' },
    created: 1789900000,
  };

  // Basic is free: `no_payment_required` is what success looks like for it.
  const free = signed({ ...base, metadata: { plan: 'basic' } }, 'evt_free_1');
  assert.equal(free.payment.plan, 'basic');
  assert.equal(free.payment.email, PURCHASER);

  // The same status on a paid tier is not success, and must provision nothing - this
  // is the whole reason the rule is read off our catalog and not off the session.
  const pretending = signed(
    { ...base, id: 'cs_live_pretend', metadata: { plan: 'pro' } },
    'evt_free_2',
  );
  assert.equal(pretending.payment, undefined, 'a paid tier still requires payment');

  // A plan we do not sell, however well signed, is not ours to act on.
  const unknown = signed(
    { ...base, id: 'cs_live_unknown', payment_status: 'paid', metadata: { plan: 'gold' } },
    'evt_free_3',
  );
  assert.equal(unknown.payment, undefined, 'an unknown plan provisions nothing');

  // Enterprise is never sold through checkout, so a session claiming it is ignored.
  const enterprise = signed(
    {
      ...base,
      id: 'cs_live_ent',
      payment_status: 'paid',
      metadata: { plan: 'enterprise' },
    },
    'evt_free_4',
  );
  assert.equal(enterprise.payment, undefined, 'contact-only tiers are not provisioned');
});

# Public subscriptions and admin provisioning

A visitor buys a subscription from the marketing site, and an Admin account is created
for them. They have no account while they are buying — creating one is what the purchase
does.

```
/  →  /subscribe  →  Stripe Checkout  →  payment settles
                                              ↓  (signed webhook, server to server)
                                    Admin account + subscription row
                                              ↓
                                   username + temporary password by email
                                              ↓
              sign in  →  locked to /change-password  →  choose a password  →  full Admin
```

## The rule that shapes everything

**The browser is never believed about payment.** Returning to `/payment/success` proves
only that a redirect happened; anyone can type that URL. The account is created solely
from `POST /billing/webhook`, which Stripe calls server to server and which is rejected
unless the body carries a valid signature over the exact bytes Stripe signed.

The return page therefore reports what the *provider* says about the session and points
at the purchaser's inbox. It never shows credentials, and it never claims the account
exists — at that instant, it may be a second away.

## Idempotency: three locks, all in the database

Payment providers deliver at least once, and retry on any non-2xx. Every layer is
enforced by a constraint rather than a check-then-act, because check-then-act has a
window and concurrent webhook deliveries will find it:

| Level | Mechanism | Stops |
|---|---|---|
| Event | `processed_payment_events.event_id` primary key; insert *is* the claim | The same delivery being processed twice |
| Purchase | `subscriptions.checkout_session_id` unique index | Different events about one purchase creating two subscriptions |
| Account | `users.email` unique index | Two concurrent runs creating two admins |

If account creation loses that last race, it does not fail — it looks up the winner's
user and links to it, and does **not** send a second credentials email.

A failed attempt **releases** its event claim and returns 5xx, so the provider's retry
does real work. Marking an event handled after a transient database blip is how a paying
customer ends up with no account and no trace.

## Failure between payment and account

The subscription row is written **before** the account exists, and `user_id` is nullable
for exactly that reason. Two separate fields record what happened:

- `status` — what the money did (`active`, `past_due`, `canceled`, `incomplete`)
- `provisioning_status` — what we managed to do about it (`pending`, `provisioned`,
  `email_failed`, `failed`), plus `provisioning_error` saying why

A paid subscription whose credentials email bounced is `active` / `email_failed`:
visible, explicable and retryable, rather than silently lost.

```bash
npm run subscriptions:pending                  # the queue, with reasons
npm run subscriptions:resend -- --email a@b.c  # re-issue credentials
```

`resend` mints a **new** temporary password and re-locks the account. If the first email
did arrive and was read by the wrong person, this takes it back. It refuses to run
unless SMTP is configured — printing a credential to a terminal is not delivery.

## Paying with an existing account's email

The subscription is linked to that account. Its **role, password and confinement are not
touched**.

This is deliberate and is the single most important rule in the flow. Promoting an
existing user to Admin because someone paid with their email address would make the
public checkout form a privilege-escalation tool: anyone could type a colleague's
address — or their own, as a restricted Onsite Engineer — and buy themselves
administration over projects they were deliberately kept out of. Money is recorded; who
someone is stays an administrative decision.

Verified end to end: an Onsite Engineer who pays remains an Onsite Engineer, still sees
only their assigned projects, and still gets 403 from `/admin/users`.

## Credentials

- **Username** — from a requested one if valid and free, else derived from the name or
  email (`John Smith` → `john.smith`, diacritics folded). Collisions get a *random*
  suffix, never sequential: `johnsmith42` tells an attacker nothing, `johnsmith2` tells
  them how many accounts exist and what to guess next.
- **Temporary password** — 16 characters from `crypto.randomInt`, one from each of four
  classes, Fisher-Yates shuffled. `l I 1 O 0` are excluded because it is read off a
  screen and typed once. About 96 bits of entropy.
- **Storage** — the plaintext exists only inside the provisioning call and the email it
  produces. It is never returned by an API, never logged, and never stored; the database
  holds a salted scrypt hash.

## The lock until the password is changed

`users.must_change_password` is set when an account is provisioned. While it stands, the
account is authenticated but **confined**: the global `AuthorizationGuard` refuses every
route that has not opted in with `@AllowWhilePasswordChangePending()`, ahead of role,
permission and project checks. Only three routes opt in:

```
GET  /auth/me              POST /auth/logout          POST /auth/change-password
```

Everything else answers **403 — "You must change your temporary password before
continuing"**, including `/projects`, `/incidents`, `/admin/*` and `/system/info`. The
React `RequirePasswordChanged` guard wraps the whole authenticated shell, so a page added
later is covered — but it is only a courtesy. Editing the URL or calling the API with
curl reaches the guard, not the data.

The flag is read from storage on every request, never from the token. Changing the
password therefore releases the account immediately, including for the token issued
before the change, and `POST /auth/change-password` returns a refreshed session anyway.

The current password is required even though the caller is authenticated: a token alone
is not proof of knowing the password, and without that check a stolen token becomes
permanent ownership.

## Schema (`0011_subscriptions_and_provisioning.sql`)

```
users  + username (unique, nullable)       -- provisioned admins sign in with either
       + must_change_password              -- the confinement flag

subscriptions        -- one per purchase; user_id nullable until provisioned
processed_payment_events  -- event_id PRIMARY KEY; the idempotency ledger
```

`0012_audit_log_user_reference.sql` drops `audit_log.user_id`'s foreign key. Migration
0005 gave it `ON DELETE SET NULL` *and* made the table append-only; PostgreSQL implements
SET NULL as an UPDATE, the append-only rule discards it, and deleting any user with audit
history failed outright. The trail keeps `actor` precisely so it survives a user's
removal, so the constraint went rather than the rule.

## Plans

Three tiers, and they are not the same kind of thing. The catalog is
`packages/billing/src/plans.ts`, so the pricing page renders without a provider round
trip and a `plan` in a request is validated against something this codebase owns.

| Plan | Price | Bought how |
|---|---|---|
| `basic` | Free | direct email signup; Stripe is not used |
| `pro` | $49.00 / month | hosted checkout |
| `enterprise` | Custom | sales conversation — `BILLING_SALES_CONTACT` |

Basic uses `POST /billing/free-signup`. The endpoint always provisions Basic, creates the
administrator account through the same audited provisioning service, and emails the
temporary credentials. It does not create a checkout session or call Stripe. A stable,
email-derived signup id makes retries idempotent, while an existing account returns 409.

Enterprise has no amount and no price id. `POST /billing/checkout` rejects it with a 400
that says why, and a signed webhook naming it provisions nothing.

## Tiers and entitlements

What a tier *unlocks* is `packages/billing/src/entitlements.ts`. `Plan.features` is prose
for the pricing page; these are the ids the API enforces, kept apart so a reworded bullet
cannot quietly open or close a module.

Modules match the console's navigation, one per page:

| Module | id | From | Routes gated |
|---|---|---|---|
| Onboarded Clusters | `clusters` | Basic | - |
| Cluster Onboarding | `cluster-onboarding` | Basic (1 cluster) | cluster limit, see below |
| Incidents | `incidents` | Basic | - |
| Alerts | `alerts` | Basic | - |
| Incident Ledger | `incident-ledger` | Basic | - |
| Team & Roles | `team-management` | Pro | `/admin/users` |
| Integrations | `integrations` | Pro | `/integrations/slack`, `/clusters/:id/slack-*` |
| Runtime | `log-aggregator` | Pro | `/telemetry/*`, `/resources/*`, `/baselines` |
| Reports | `reporting` | Pro | `/analytics/incidents*`, `/reports/system-summary` |
| Voice Agent | `voice-call-agent` | Pro | `/contacts`, `/notification-groups`, `/on-call/*`, `/clusters/:id/sres`, `/incidents/:id/communications` and siblings |
| Remediation | `auto-remediation` | Enterprise | none yet - not built |

Basic modules carry no decorator: every account holds at least Basic, so a check would
only cost a query. An incident's own evidence and technical report belong to Incidents,
not to Runtime or Reports, so a Basic account can still investigate what it is alerted to.

Tiers are ranked, and a tier carries everything below it. That is a property of the model
rather than something each list restates, so a module added to Basic later cannot be
withheld from the tiers above it.

**A plan belongs to the organization.** The subscription is bought by the organization's
owner, and every account in the organization works under it: an engineer's tier is the
best live subscription among themselves and their organization's Admins. Reading only the
engineer's own row would put every engineer on Basic.

**Basic may register one cluster.** `POST /cluster-onboarding` and `POST /clusters` refuse
a new cluster once the organization has used its allowance, with the same structured 403
as a locked module plus `limit: { clusters, used }`. The check runs before the onboarding
job starts, so nothing is installed into a cluster that is then refused. Uninstalling the
existing cluster frees the slot. The operator CLI (`npm run cluster:onboard`) is not a
customer path and is not limited.

A route declares what it needs:

```ts
@Get('voice/calls')
@RequirePermission(PERMISSIONS.INCIDENT_READ)   // may this person?
@RequiresFeature(FEATURES.VOICE_AGENT)          // did their plan buy it?
list() { … }
```

The two are different questions and both must pass. An Admin on Basic is still an Admin;
there is simply no Voice Agent on their plan to administer. `EntitlementsGuard` runs
*after* authentication, the password-change confinement and the role/project checks, so a
stranger is never told which tier a module belongs to, and only a route that declares a
module pays for the subscription lookup.

**No live subscription means the free tier, not nothing.** Cancelled, past due, or never
subscribed all read as `basic`: a lapsed Pro account keeps its clusters, incidents and
Incident Ledger rather than losing its history the day a card expires. With
`BILLING_ENABLED=false` nothing is enforced at all - a self-hosted deployment sells no
plans, so falling back to `basic` there would switch paid modules off for everyone.

A refusal returns 403 with a structured body - `feature`, `plan`, `requiredPlan`,
`requiredPlanName` - so the console can offer the upgrade instead of parsing prose, and
it is written to the audit trail like any other denial (`resourceType: 'feature'`,
`metadata.check: 'plan'`).

## Endpoints

| Method | Path | Auth |
|---|---|---|
| `GET` | `/billing/plans` | public — pricing for the page |
| `POST` | `/billing/checkout` | public — `{email, plan, fullName?, username?}` → `{checkoutUrl}` |
| `POST` | `/billing/free-signup` | public — creates a Basic account without Stripe |
| `POST` | `/billing/upgrade` | Admin — `{plan: "pro"}` → authenticated Stripe checkout URL |
| `POST` | `/billing/webhook` | **signature only** — provisions paid checkout results |
| `GET` | `/billing/checkout/status?sessionId=` | public — `{paid, email}`, never credentials |
| `GET` | `/billing/entitlements` | authenticated — the caller's tier, its modules, and what is locked |
| `POST` | `/billing/portal` | Admin — opens Stripe-hosted billing management |
| `POST` | `/auth/change-password` | authenticated, allowed while confined |
| `POST` | `/auth/login` | public — accepts `email` **or** `username` |

With `BILLING_ENABLED=false` the purchase routes are **not registered at all**, so a
deployment that does not sell subscriptions has no public account-creating surface.
`/billing/entitlements` is the exception and is always registered: the console asks what
the account may reach on every deployment, and with billing off the honest answer is
"everything, unenforced" rather than a 404 to interpret.

## Configuration

```bash
BILLING_ENABLED=true
STRIPE_SECRET_KEY=sk_live_...        # server side only
STRIPE_WEBHOOK_SECRET=whsec_...      # from the webhook endpoint you create
STRIPE_PRICE_ID_BASIC=price_...      # the recurring Price for Basic (amount 0)
STRIPE_PRICE_ID_PRO=price_...        # the recurring Price for the Pro plan
BILLING_SALES_CONTACT=sales@example.com  # optional; the Enterprise card's mailto
APP_PUBLIC_URL=https://app.example.com   # where the customer's browser reaches the UI
APP_NAME=Faultline

EMAIL_TRANSPORT=smtp                 # `log` is development only
EMAIL_FROM=Faultline <no-reply@example.com>
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=
SMTP_PASSWORD=
```

Configuration validation refuses to start the API when billing is on and any Stripe
setting is missing — half-configured billing means checkout succeeds and the webhook
that provisions the account cannot be verified. It also refuses `EMAIL_TRANSPORT=log` in
production with billing on, because a purchaser whose credentials reached only a log file
has bought nothing they can use.

### Stripe setup

1. Create a recurring **Price** for each self-serve tier: Basic at amount `0` →
   `STRIPE_PRICE_ID_BASIC`, and Pro → `STRIPE_PRICE_ID_PRO`. Enterprise has none.
2. Add a webhook endpoint at `https://<api-host>/billing/webhook` subscribed to
   **`checkout.session.completed`**, **`invoice.paid`**, **`invoice.payment_failed`**,
   **`customer.subscription.updated`**, and **`customer.subscription.deleted`**. Its
   signing secret is `STRIPE_WEBHOOK_SECRET`.
   Enable subscription updates in the Stripe Customer Portal and make both configured
   Basic and Pro prices available. Active price changes update Faultline immediately;
   canceled or unpaid subscriptions fall back to Basic automatically.
3. Locally: `stripe listen --forward-to localhost:3000/billing/webhook` and use the
   `whsec_…` it prints.

The webhook must reach the **API** (port 3000), not the Vite dev server.

## Testing

```bash
npm run test:subscriptions   # provisioning, portal and lifecycle tests
npm run test:entitlements    # tier gating, over real HTTP
npm test                     # full suite
```

Covered: temporary-password randomness and character classes; username derivation,
validation and non-sequential collision suffixes; provisioning creating exactly one
admin with the right role, flag and hash; the email carrying username, password and
login link; redelivered events; existing-email linking without promotion; email failure
leaving a retryable record; forged, unsigned, tampered and wrong-secret webhooks;
unpaid and irrelevant events; provisioning failure releasing the event; checkout
validation; first login by username and email; the confinement across protected routes;
change-password validation, success, hash replacement, dead temporary password; and the
existing RBAC still confining an engineer afterwards.

The real `StripeGateway` is exercised against signatures produced by Stripe's own
`generateTestHeaderString`, so the verification path is tested rather than mocked.

> Running the test suite from inside Claude Code makes two foundation tests fail: the
> Stripe SDK prints a `<claude-code-hint …>` line to stderr when `CLAUDECODE` is set,
> and those tests assert the app emits only JSON log lines. It does not happen in a
> normal shell or in production.

## Limitations

1. **The webhook is the only provisioning path.** If webhooks are misconfigured, nobody
   is provisioned — `npm run subscriptions:pending` will show nothing, because without
   the webhook there is no subscription row either. Verify the endpoint after deploying.
2. **`RecordingEmailSender` keeps messages in memory** for the life of the process when
   `EMAIL_TRANSPORT=log`. Development only, and production configuration forbids it.

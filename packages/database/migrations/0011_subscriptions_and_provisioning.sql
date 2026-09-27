-- migrate:up
-- Public subscription purchase, and the admin account it provisions.

ALTER TABLE users
  -- Unique login handle, generated at provisioning. Nullable because accounts created
  -- before this migration (and by the CLI) sign in with their email.
  ADD COLUMN username text,
  -- True while the account still holds a temporary password someone else generated.
  -- The API confines such an account to the password-change endpoint.
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX users_username_key ON users (lower(username))
  WHERE username IS NOT NULL;

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  -- Null until the admin account has been provisioned. The row is written the moment
  -- payment is confirmed, so a payment is never lost because provisioning failed after.
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text NOT NULL,
  payment_provider text NOT NULL,
  payment_provider_customer_id text,
  payment_provider_subscription_id text,
  -- The checkout session that opened this subscription. Unique, and the idempotency
  -- key that stops a redelivered webhook provisioning a second admin: two concurrent
  -- inserts cannot both win, and the loser reads back the winner's row.
  checkout_session_id text,
  plan text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
  -- What the money did vs what we managed to do about it: a paid subscription whose
  -- credentials email bounced is active/email_failed, which is visible and retryable.
  provisioning_status text NOT NULL DEFAULT 'pending'
    CHECK (provisioning_status IN ('pending', 'provisioned', 'email_failed', 'failed')),
  provisioning_error text,
  start_date timestamptz,
  end_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX subscriptions_checkout_session_key
  ON subscriptions (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_provider_subscription_key
  ON subscriptions (payment_provider_subscription_id)
  WHERE payment_provider_subscription_id IS NOT NULL;
CREATE INDEX subscriptions_email ON subscriptions (lower(email));
CREATE INDEX subscriptions_user ON subscriptions (user_id);
-- The reconciliation pass reads this: paid, but not fully provisioned.
CREATE INDEX subscriptions_unprovisioned ON subscriptions (provisioning_status, created_at)
  WHERE provisioning_status <> 'provisioned';

-- Payment providers guarantee at-least-once delivery, so "have I already acted on this
-- event?" has to be answered from storage rather than from hope. The primary key is the
-- provider's event id: inserting it is the claim, and a duplicate insert fails.
CREATE TABLE processed_payment_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- migrate:down
DROP TABLE processed_payment_events;
DROP TABLE subscriptions;
DROP INDEX users_username_key;
ALTER TABLE users
  DROP COLUMN must_change_password,
  DROP COLUMN username;

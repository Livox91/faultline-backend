-- migrate:up

ALTER TABLE subscriptions
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;

-- migrate:down

ALTER TABLE subscriptions DROP COLUMN cancel_at_period_end;

-- migrate:up
ALTER TABLE escalation_executions
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz;
CREATE INDEX escalation_executions_due_idx
  ON escalation_executions (next_attempt_at)
  WHERE status = 'ACTIVE';
CREATE TABLE notification_idempotency (
  key text PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

-- migrate:down
DROP TABLE notification_idempotency;
DROP INDEX escalation_executions_due_idx;
ALTER TABLE escalation_executions
  DROP COLUMN lease_expires_at,
  DROP COLUMN lease_owner,
  DROP COLUMN next_attempt_at,
  DROP COLUMN status;

-- migrate:up
ALTER TABLE notification_contacts
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE notification_contacts
SET user_id = (aggregate->>'userId')::uuid
WHERE aggregate ? 'userId'
  AND aggregate->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

CREATE UNIQUE INDEX notification_contacts_org_user_idx
  ON notification_contacts (organization_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE incident_notification_states (
  incident_id text PRIMARY KEY,
  cluster_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),
  aggregate jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_notification_states_cluster_idx
  ON incident_notification_states (organization_id, cluster_id, updated_at DESC);

INSERT INTO incident_notification_states
  (incident_id, cluster_id, organization_id, status, aggregate, updated_at)
SELECT e.incident_id,
       i.cluster_id,
       c.organization_id,
       CASE
         WHEN e.status = 'ACKNOWLEDGED' THEN 'ACKNOWLEDGED'
         WHEN e.status = 'RESOLVED' THEN 'RESOLVED'
         WHEN e.status = 'ACTIVE' THEN 'ACTIVE'
         ELSE 'RESOLVED'
       END,
       jsonb_build_object(
         'incidentId', e.incident_id,
         'clusterId', i.cluster_id,
         'organizationId', c.organization_id,
         'recipientIds', '[]'::jsonb,
         'fallbackUsed', false,
         'status', CASE
           WHEN e.status = 'ACKNOWLEDGED' THEN 'ACKNOWLEDGED'
           WHEN e.status = 'RESOLVED' THEN 'RESOLVED'
           WHEN e.status = 'ACTIVE' THEN 'ACTIVE'
           ELSE 'RESOLVED'
         END,
         'startedAt', COALESCE(e.aggregate->>'startedAt', e.updated_at::text),
         'updatedAt', e.updated_at::text,
         'completedAt', e.aggregate->'completedAt'
       ),
       e.updated_at
FROM escalation_executions e
JOIN incidents i ON i.id::text = e.incident_id
JOIN clusters c ON c.id = i.cluster_id;

DROP TABLE escalation_executions;
DROP TABLE escalation_policies;

-- migrate:down
CREATE TABLE escalation_policies (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  aggregate jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalation_policies_org_idx ON escalation_policies (organization_id);

CREATE TABLE escalation_executions (
  incident_id text PRIMARY KEY,
  policy_id text NOT NULL,
  aggregate jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'ACTIVE',
  next_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz
);
CREATE INDEX escalation_executions_due_idx
  ON escalation_executions (next_attempt_at)
  WHERE status = 'ACTIVE';

DROP TABLE incident_notification_states;
DROP INDEX notification_contacts_org_user_idx;
ALTER TABLE notification_contacts DROP COLUMN user_id;

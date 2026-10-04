-- migrate:up
ALTER TABLE incident_communications
  ADD COLUMN organization_id text REFERENCES organizations(id);

UPDATE incident_communications communication
   SET organization_id=state.organization_id
  FROM incident_notification_states state
 WHERE state.incident_id=communication.incident_id;

CREATE INDEX incident_communications_org_recent_idx
  ON incident_communications (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE TABLE notification_provider_status (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  aggregate jsonb NOT NULL,
  checked_at timestamptz NOT NULL
);

-- migrate:down
DROP TABLE notification_provider_status;
DROP INDEX incident_communications_org_recent_idx;
ALTER TABLE incident_communications DROP COLUMN organization_id;

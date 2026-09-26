-- migrate:up
CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (id, name) VALUES ('default', 'Default organization');

ALTER TABLE users
  ADD COLUMN organization_id text NOT NULL DEFAULT 'default'
    REFERENCES organizations(id);
CREATE INDEX users_organization_idx ON users (organization_id);

ALTER TABLE clusters
  ADD COLUMN organization_id text NOT NULL DEFAULT 'default'
    REFERENCES organizations(id);
CREATE INDEX clusters_organization_idx ON clusters (organization_id);

CREATE TABLE slack_integrations (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  slack_enabled boolean NOT NULL DEFAULT false,
  slack_bot_token text,
  slack_incident_channel_id text,
  slack_service_channels jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(slack_service_channels) = 'object')
);

-- migrate:down
DROP TABLE slack_integrations;
DROP INDEX clusters_organization_idx;
ALTER TABLE clusters DROP COLUMN organization_id;
DROP INDEX users_organization_idx;
ALTER TABLE users DROP COLUMN organization_id;
DROP TABLE organizations;

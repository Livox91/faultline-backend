-- migrate:up
CREATE TABLE cluster_end_user_contacts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cluster_id text NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  phone_number text NOT NULL,
  service text NOT NULL,
  service_key text GENERATED ALWAYS AS (lower(service)) STORED,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(cluster_id, phone_number, service_key)
);
CREATE INDEX cluster_end_user_contacts_scope_idx
  ON cluster_end_user_contacts(cluster_id, organization_id, enabled);

-- migrate:down
DROP TABLE cluster_end_user_contacts;

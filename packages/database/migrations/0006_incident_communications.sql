-- migrate:up
CREATE TABLE incident_communications (
  id text PRIMARY KEY,
  incident_id text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  aggregate jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX incident_communications_incident_idx
  ON incident_communications (incident_id, created_at);

-- migrate:down
DROP TABLE incident_communications;

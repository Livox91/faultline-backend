-- migrate:up
CREATE TABLE incident_external_tickets (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  provider text NOT NULL,
  channel_id text NOT NULL,
  external_message_id text NOT NULL,
  url text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (incident_id, provider)
);

CREATE UNIQUE INDEX incident_external_tickets_provider_message_idx
  ON incident_external_tickets (provider, channel_id, external_message_id);

-- migrate:down
DROP TABLE incident_external_tickets;

-- migrate:up
CREATE TABLE clusters (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY,
  correlation_key text NOT NULL,
  cluster_id text NOT NULL REFERENCES clusters(id),
  namespace text,
  classification text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  resolved_at timestamptz,
  stabilization_started_at timestamptz,
  primary_resource jsonb NOT NULL,
  aggregate jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incidents_active_lookup ON incidents (correlation_key, last_seen DESC) WHERE status <> 'RESOLVED';
CREATE INDEX incidents_filters ON incidents (cluster_id, namespace, status, severity, classification, last_seen DESC);

CREATE TABLE incident_affected_resources (
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  resource jsonb NOT NULL,
  PRIMARY KEY (incident_id, resource_key)
);

CREATE TABLE incident_anomalies (
  anomaly_id text PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  classification text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  anomaly jsonb NOT NULL
);
CREATE INDEX incident_anomalies_incident ON incident_anomalies (incident_id);

CREATE TABLE incident_evidence (
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  evidence_key text NOT NULL,
  anomaly_id text NOT NULL,
  event_id text,
  evidence jsonb NOT NULL,
  PRIMARY KEY (incident_id, evidence_key)
);

CREATE TABLE incident_timeline (
  id text PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  type text NOT NULL,
  anomaly_id text NOT NULL,
  entry jsonb NOT NULL
);
CREATE INDEX incident_timeline_order ON incident_timeline (incident_id, occurred_at, id);

-- migrate:down
DROP TABLE incident_timeline;
DROP TABLE incident_evidence;
DROP TABLE incident_anomalies;
DROP TABLE incident_affected_resources;
DROP TABLE incidents;
DROP TABLE clusters;

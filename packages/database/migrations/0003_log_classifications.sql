-- migrate:up
-- Derived semantic metadata only. Full normalized logs remain in ClickHouse.
CREATE TABLE log_classifications (
  event_id text PRIMARY KEY,
  classification text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  classifier_type text NOT NULL,
  pattern_id text NOT NULL,
  model_version text NOT NULL,
  occurred_at timestamptz NOT NULL,
  evidence jsonb NOT NULL
);
CREATE INDEX log_classifications_pattern ON log_classifications (pattern_id, occurred_at DESC);

CREATE TABLE log_pattern_aggregates (
  pattern_id text PRIMARY KEY,
  cluster_id text NOT NULL REFERENCES clusters(id),
  namespace text,
  workload text,
  classification text NOT NULL,
  occurrence_count bigint NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  affected_pods text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX log_pattern_aggregates_workload
  ON log_pattern_aggregates (cluster_id, namespace, workload, last_seen DESC);

-- migrate:down
DROP TABLE log_pattern_aggregates;
DROP TABLE log_classifications;

-- migrate:up
-- Baselines are derived control-plane state: small, queryable, and recomputable from
-- ClickHouse at any time. They live beside incidents rather than in the telemetry store
-- because the processor must keep detecting while ClickHouse is unavailable, and it
-- already holds a PostgreSQL connection.
CREATE TABLE metric_baselines (
  cluster_id text NOT NULL REFERENCES clusters(id),
  namespace text NOT NULL,
  workload text NOT NULL,
  resource_type text NOT NULL,
  metric_name text NOT NULL,
  window_name text NOT NULL,
  -- 'all' today. Seasonal baselines become additional rows, never a schema change.
  season text NOT NULL DEFAULT 'all',
  status text NOT NULL,
  sample_count bigint NOT NULL,
  unit text,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  excluded_ranges integer NOT NULL DEFAULT 0,
  -- Null while status is BASELINE_NOT_READY: an unusable baseline stores no statistics.
  statistics jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, namespace, workload, resource_type, metric_name, window_name, season)
);

-- The detector's hot path: every baseline for one workload, in one index scan.
CREATE INDEX metric_baselines_workload ON metric_baselines (cluster_id, namespace, workload);
-- Supports the baselines API filters and the staleness sweep.
CREATE INDEX metric_baselines_freshness ON metric_baselines (updated_at);

-- migrate:down
DROP TABLE metric_baselines;

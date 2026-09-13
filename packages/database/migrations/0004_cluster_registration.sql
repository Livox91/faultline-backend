-- migrate:up
ALTER TABLE clusters
  ADD COLUMN name text,
  ADD COLUMN kubernetes_context text,
  ADD COLUMN workload_namespace text,
  ADD COLUMN workload_selector text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE clusters SET name = id WHERE name IS NULL;

-- migrate:down
ALTER TABLE clusters
  DROP COLUMN updated_at,
  DROP COLUMN workload_selector,
  DROP COLUMN workload_namespace,
  DROP COLUMN kubernetes_context,
  DROP COLUMN name;

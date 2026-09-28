-- migrate:up
ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS slack_channel_id text,
  ADD COLUMN IF NOT EXISTS slack_channel_name text;

ALTER TABLE clusters
  DROP CONSTRAINT IF EXISTS clusters_slack_mapping_pair,
  ADD CONSTRAINT clusters_slack_mapping_pair CHECK (
    (slack_channel_id IS NULL AND slack_channel_name IS NULL)
    OR (slack_channel_id IS NOT NULL AND slack_channel_name IS NOT NULL)
  );

COMMENT ON COLUMN clusters.slack_channel_id IS
  'Slack conversation selected for new incidents from this cluster.';
COMMENT ON COLUMN clusters.slack_channel_name IS
  'Last verified display name for slack_channel_id; refreshed when mapping is saved.';

-- migrate:down
ALTER TABLE clusters
  DROP CONSTRAINT IF EXISTS clusters_slack_mapping_pair,
  DROP COLUMN IF EXISTS slack_channel_name,
  DROP COLUMN IF EXISTS slack_channel_id;

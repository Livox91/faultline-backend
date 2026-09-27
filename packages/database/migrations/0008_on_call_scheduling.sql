-- migrate:up
CREATE TABLE on_call_schedules (id text PRIMARY KEY, organization_id text NOT NULL, team_id text NOT NULL, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX on_call_schedules_org_team_idx ON on_call_schedules (organization_id, team_id);
CREATE TABLE on_call_shifts (id text PRIMARY KEY, schedule_id text NOT NULL REFERENCES on_call_schedules(id) ON DELETE CASCADE, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), CHECK (ends_at > starts_at));
CREATE INDEX on_call_shifts_lookup_idx ON on_call_shifts (schedule_id, starts_at, ends_at);
CREATE TABLE availability_overrides (id text PRIMARY KEY, schedule_id text NOT NULL REFERENCES on_call_schedules(id) ON DELETE CASCADE, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), CHECK (ends_at > starts_at));
CREATE INDEX availability_overrides_lookup_idx ON availability_overrides (schedule_id, starts_at, ends_at);

-- migrate:down
DROP TABLE availability_overrides;
DROP TABLE on_call_shifts;
DROP TABLE on_call_schedules;

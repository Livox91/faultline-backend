-- migrate:up
-- Identity, project assignment and the audit trail.
--
-- A project is a cluster: the control plane already keys incidents, baselines and
-- telemetry by cluster_id, so making the cluster the unit of assignment means every
-- existing read path becomes authorized by filtering on a column it already carries.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  -- Stored lower-cased; the unique index is what makes one email one identity.
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'onsiteengineer')),
  -- Null for users whose credentials live in an external IdP (SSO/OIDC/LDAP).
  password_hash text,
  -- The subject an external IdP will present. Unused until one is configured.
  external_subject text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  mfa_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_external_subject_key ON users (external_subject)
  WHERE external_subject IS NOT NULL;
CREATE INDEX users_role ON users (role);

-- The many-to-many that is the single source of truth for engineer project access.
-- There is no second place to grant it: no per-user flag, no per-project override.
CREATE TABLE project_users (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  -- Empty means every environment of the project. This column is the seam for the
  -- environment-level restrictions that come later; nothing enforces it yet.
  environments text[] NOT NULL DEFAULT '{}',
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX project_users_project ON project_users (project_id);

-- Environment a cluster represents. Advisory today, read by the environment-level
-- checks once they are turned on.
ALTER TABLE clusters
  ADD COLUMN environment text NOT NULL DEFAULT 'production';

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  -- Nullable so a failed login, which has no identified actor, still leaves a trail.
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Kept alongside the id so the trail stays readable after a user row is removed.
  actor text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  ip text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_recent ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_actor ON audit_log (user_id, occurred_at DESC);
CREATE INDEX audit_log_action ON audit_log (action, occurred_at DESC);
CREATE INDEX audit_log_resource ON audit_log (resource_type, resource_id, occurred_at DESC);

-- Append-only at the table, not merely by convention. A rule rewrites any UPDATE or
-- DELETE into nothing, so an application bug, a compromised API process or an operator
-- with write access cannot quietly rewrite history. Dropping the audit trail is
-- deliberately a migration, which is itself reviewable.
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- migrate:down
DROP RULE audit_log_no_delete ON audit_log;
DROP RULE audit_log_no_update ON audit_log;
DROP TABLE audit_log;
ALTER TABLE clusters DROP COLUMN environment;
DROP TABLE project_users;
DROP TABLE users;

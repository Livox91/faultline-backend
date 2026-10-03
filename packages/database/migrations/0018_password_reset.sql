-- migrate:up
-- Opaque, single-use password recovery. Only the token digest is persisted. The
-- session version makes a successful reset revoke access tokens issued beforehand.

ALTER TABLE users
  ADD COLUMN session_version integer NOT NULL DEFAULT 1
  CHECK (session_version > 0);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user
  ON password_reset_tokens (user_id, created_at DESC);
CREATE INDEX password_reset_tokens_expiry
  ON password_reset_tokens (expires_at);

-- migrate:down
DROP TABLE password_reset_tokens;
ALTER TABLE users DROP COLUMN session_version;

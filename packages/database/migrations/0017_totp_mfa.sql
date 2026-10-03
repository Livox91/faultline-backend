-- migrate:up
-- Authenticator-app MFA. Secrets are encrypted by the API before storage; recovery
-- codes are one-way HMAC digests and login challenges are single-use database rows.

ALTER TABLE users
  ADD COLUMN mfa_secret_ciphertext text,
  ADD COLUMN mfa_recovery_code_hashes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN mfa_last_used_counter bigint;

-- Older builds allowed an administrator to flip the boolean without enrolling a
-- factor. Such a row never had a usable second factor, so normalize it before adding
-- the invariant that enabled means configured.
UPDATE users SET mfa_enabled = false WHERE mfa_enabled = true;

ALTER TABLE users
  ADD CONSTRAINT users_mfa_configuration
  CHECK (
    (mfa_enabled = false) OR
    (mfa_secret_ciphertext IS NOT NULL AND cardinality(mfa_recovery_code_hashes) > 0)
  );

CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_challenges_expiry ON mfa_challenges (expires_at);
CREATE INDEX mfa_challenges_user ON mfa_challenges (user_id, created_at DESC);

-- migrate:down
DROP TABLE mfa_challenges;
ALTER TABLE users DROP CONSTRAINT users_mfa_configuration;
ALTER TABLE users
  DROP COLUMN mfa_last_used_counter,
  DROP COLUMN mfa_recovery_code_hashes,
  DROP COLUMN mfa_secret_ciphertext;

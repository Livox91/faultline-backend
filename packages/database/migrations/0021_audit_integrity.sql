-- migrate:up
-- Existing rows remain visibly unsigned. Every subsequent row is HMAC chained by the
-- application, while this monotonic sequence provides an unambiguous global order.
ALTER TABLE audit_log
  ADD COLUMN chain_sequence bigserial,
  ADD COLUMN previous_hash text CHECK (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN record_hash text CHECK (record_hash IS NULL OR record_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN integrity_version smallint,
  ADD COLUMN integrity_key_id text,
  ADD CONSTRAINT audit_log_integrity_complete CHECK (
    (record_hash IS NULL AND previous_hash IS NULL AND integrity_version IS NULL AND integrity_key_id IS NULL)
    OR
    (record_hash IS NOT NULL AND integrity_version = 1 AND integrity_key_id IS NOT NULL)
  );

-- NOT VALID deliberately leaves pre-migration rows untouched, but PostgreSQL still
-- enforces this constraint for every future INSERT/UPDATE. That prevents a caller
-- from bypassing the integrity chain by appending a row with all integrity fields null.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_new_rows_signed CHECK (
    record_hash IS NOT NULL
    AND integrity_version = 1
    AND integrity_key_id IS NOT NULL
  ) NOT VALID;

CREATE UNIQUE INDEX audit_log_chain_sequence ON audit_log (chain_sequence);
CREATE UNIQUE INDEX audit_log_record_hash ON audit_log (record_hash) WHERE record_hash IS NOT NULL;

-- migrate:down
DROP INDEX audit_log_record_hash;
DROP INDEX audit_log_chain_sequence;
ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_new_rows_signed,
  DROP CONSTRAINT audit_log_integrity_complete,
  DROP COLUMN integrity_key_id,
  DROP COLUMN integrity_version,
  DROP COLUMN record_hash,
  DROP COLUMN previous_hash,
  DROP COLUMN chain_sequence;

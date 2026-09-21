-- migrate:up
-- Lets a user be removed without the audit trail blocking it.
--
-- Migration 0005 gave `audit_log.user_id` an ON DELETE SET NULL reference to `users`,
-- and also made the table append-only with a rule that rewrites UPDATE to nothing.
-- Those two are incompatible: PostgreSQL implements SET NULL as an UPDATE, the rule
-- discards it, and the delete fails with
--
--   referential integrity query on "users" ... gave unexpected result
--
-- so any user with audit history could never be deleted at all. That was not the
-- intent - the trail keeps `actor` precisely so it stays readable once a user row is
-- gone - it was an unnoticed interaction between the two.
--
-- The constraint is dropped rather than the rule weakened: the rule is the thing
-- actually protecting the trail, and an audit row referencing a departed user is
-- exactly the case `actor` exists to cover. `user_id` stays as a plain column, still
-- indexed, still the right thing to filter by.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_user_id_fkey;

-- migrate:down
-- Restores the constraint. Note that doing so reintroduces the interaction above:
-- deleting a user with audit history will fail again while the append-only rules stand.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

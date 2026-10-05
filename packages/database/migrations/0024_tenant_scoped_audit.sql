-- migrate:up
ALTER TABLE audit_log ADD COLUMN organization_id text REFERENCES organizations(id);
DROP RULE audit_log_no_update ON audit_log;
UPDATE audit_log audit SET organization_id = users.organization_id FROM users WHERE audit.user_id = users.id;
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE INDEX audit_log_organization_recent ON audit_log (organization_id, occurred_at DESC);
-- migrate:down
DROP INDEX audit_log_organization_recent;
ALTER TABLE audit_log DROP COLUMN organization_id;

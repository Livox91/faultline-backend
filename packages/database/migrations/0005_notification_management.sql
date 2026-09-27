-- migrate:up
CREATE TABLE notification_contacts (id text PRIMARY KEY, organization_id text NOT NULL, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX notification_contacts_org_idx ON notification_contacts (organization_id);
CREATE TABLE notification_groups (id text PRIMARY KEY, organization_id text NOT NULL, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX notification_groups_org_idx ON notification_groups (organization_id);
CREATE TABLE escalation_policies (id text PRIMARY KEY, organization_id text NOT NULL, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX escalation_policies_org_idx ON escalation_policies (organization_id);
CREATE TABLE notification_attempts (id text PRIMARY KEY, incident_id text NOT NULL, provider_request_id text, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX notification_attempts_provider_idx ON notification_attempts (provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE INDEX notification_attempts_incident_idx ON notification_attempts (incident_id);
CREATE TABLE escalation_executions (incident_id text PRIMARY KEY, policy_id text NOT NULL, aggregate jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE incident_acknowledgements (incident_id text PRIMARY KEY, aggregate jsonb NOT NULL);
CREATE TABLE notification_audit_events (id text PRIMARY KEY, incident_id text NOT NULL, occurred_at timestamptz NOT NULL, aggregate jsonb NOT NULL);
CREATE INDEX notification_audit_incident_idx ON notification_audit_events (incident_id, occurred_at);

-- migrate:down
DROP TABLE notification_audit_events;
DROP TABLE incident_acknowledgements;
DROP TABLE escalation_executions;
DROP TABLE notification_attempts;
DROP TABLE escalation_policies;
DROP TABLE notification_groups;
DROP TABLE notification_contacts;

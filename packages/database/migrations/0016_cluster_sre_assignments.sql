-- migrate:up
CREATE TABLE cluster_sre_assignments (
  cluster_id text NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, user_id)
);

CREATE INDEX cluster_sre_assignments_user_idx
  ON cluster_sre_assignments (user_id, cluster_id);

CREATE FUNCTION validate_cluster_sre_assignment() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM users u
      JOIN clusters c ON c.id=NEW.cluster_id
     WHERE u.id=NEW.user_id
       AND u.role='onsiteengineer'
       AND u.status='active'
       AND u.organization_id=c.organization_id
  ) THEN
    RAISE EXCEPTION 'Cluster SRE must be an active Onsite Engineer in the cluster organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cluster_sre_assignment_valid
  BEFORE INSERT OR UPDATE ON cluster_sre_assignments
  FOR EACH ROW EXECUTE FUNCTION validate_cluster_sre_assignment();

CREATE FUNCTION remove_ineligible_cluster_sre_assignments() RETURNS trigger AS $$
BEGIN
  IF NEW.role <> 'onsiteengineer' OR NEW.status <> 'active' THEN
    DELETE FROM cluster_sre_assignments WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER remove_ineligible_cluster_sre_assignments
  AFTER UPDATE OF role, status ON users
  FOR EACH ROW EXECUTE FUNCTION remove_ineligible_cluster_sre_assignments();

INSERT INTO cluster_sre_assignments
  (cluster_id, user_id, assigned_by, assigned_at)
SELECT pu.project_id, pu.user_id, pu.assigned_by, pu.assigned_at
  FROM project_users pu
  JOIN users u ON u.id=pu.user_id
  JOIN clusters c ON c.id=pu.project_id AND c.organization_id=u.organization_id
 WHERE u.role='onsiteengineer' AND u.status='active'
ON CONFLICT (cluster_id, user_id) DO NOTHING;

-- migrate:down
DROP TRIGGER remove_ineligible_cluster_sre_assignments ON users;
DROP FUNCTION remove_ineligible_cluster_sre_assignments();
DROP TRIGGER cluster_sre_assignment_valid ON cluster_sre_assignments;
DROP FUNCTION validate_cluster_sre_assignment();
DROP TABLE cluster_sre_assignments;

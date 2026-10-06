-- migrate:up
CREATE FUNCTION enforce_project_assignment_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE user_organization text; project_organization text; actor_organization text;
BEGIN
  SELECT organization_id INTO user_organization FROM users WHERE id = NEW.user_id;
  SELECT organization_id INTO project_organization FROM clusters WHERE id = NEW.project_id;
  IF user_organization IS DISTINCT FROM project_organization THEN
    RAISE EXCEPTION 'User and project must belong to the same organization'
      USING ERRCODE = '23514', CONSTRAINT = 'project_users_same_organization';
  END IF;
  IF NEW.assigned_by IS NOT NULL THEN
    SELECT organization_id INTO actor_organization FROM users WHERE id = NEW.assigned_by;
    IF actor_organization IS DISTINCT FROM project_organization THEN
      RAISE EXCEPTION 'Assigning administrator and project must belong to the same organization'
        USING ERRCODE = '23514', CONSTRAINT = 'project_users_assigner_same_organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_users_organization_guard BEFORE INSERT OR UPDATE OF user_id, project_id, assigned_by
ON project_users FOR EACH ROW EXECUTE FUNCTION enforce_project_assignment_organization();
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM project_users pu
    JOIN users target ON target.id = pu.user_id
    JOIN clusters project ON project.id = pu.project_id
    LEFT JOIN users actor ON actor.id = pu.assigned_by
    WHERE target.organization_id IS DISTINCT FROM project.organization_id
       OR (pu.assigned_by IS NOT NULL AND actor.organization_id IS DISTINCT FROM project.organization_id)
  ) THEN RAISE EXCEPTION 'Existing project assignments cross organization boundaries'; END IF;
END; $$;
-- migrate:down
DROP TRIGGER project_users_organization_guard ON project_users;
DROP FUNCTION enforce_project_assignment_organization();

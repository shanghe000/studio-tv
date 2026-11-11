-- A Studio canvas project is an owned work item, not an IPAC project.
-- Existing work items deliberately remain unscoped until an explicit migration
-- has been reviewed; authentication alone must never claim historical data.
CREATE TABLE ipac_workspaces (
  id text PRIMARY KEY,
  application_id text NOT NULL,
  ipac_project_id text NOT NULL,
  ipac_environment_id text NOT NULL,
  project_code text NOT NULL,
  project_name text NOT NULL,
  environment_code text NOT NULL,
  environment_name text NOT NULL,
  risk_level text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(application_id,ipac_project_id,ipac_environment_id)
);
CREATE FUNCTION immutable_ipac_workspace_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.ipac_project_id IS DISTINCT FROM OLD.ipac_project_id
     OR NEW.ipac_environment_id IS DISTINCT FROM OLD.ipac_environment_id THEN
    RAISE EXCEPTION 'IPAC workspace scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ipac_workspaces_immutable_scope BEFORE UPDATE OF application_id,ipac_project_id,ipac_environment_id ON ipac_workspaces
FOR EACH ROW EXECUTE FUNCTION immutable_ipac_workspace_scope();
ALTER TABLE projects ADD COLUMN workspace_id text REFERENCES ipac_workspaces(id);
CREATE INDEX projects_owner_workspace_updated ON projects(owner_id,workspace_id,updated_at DESC) WHERE deleted_at IS NULL;
-- Prevent a later reassignment from silently changing the authorization scope
-- of an existing canvas and all its assets. Explicit legacy assignments may set
-- a NULL scope once; there is no HTTP endpoint for doing so.
CREATE FUNCTION immutable_project_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'project workspace is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_immutable_workspace BEFORE UPDATE OF workspace_id ON projects
FOR EACH ROW EXECUTE FUNCTION immutable_project_workspace();

CREATE SCHEMA IF NOT EXISTS collaboration;

ALTER TABLE public.projects ADD COLUMN collaboration_revision bigint NOT NULL DEFAULT 1 CHECK(collaboration_revision>0);
ALTER TABLE public.assets ADD COLUMN created_by text REFERENCES public.users(id) ON DELETE RESTRICT;
UPDATE public.assets SET created_by=owner_id;
ALTER TABLE public.assets ALTER COLUMN created_by SET NOT NULL;
-- Legacy private importers omit this additive field; their owner is the actor.
-- Shared writers explicitly supply the real actor instead of the storage owner.
CREATE FUNCTION collaboration.asset_creator_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.created_by:=COALESCE(NEW.created_by,NEW.owner_id);
 RETURN NEW;
END $$;
CREATE TRIGGER asset_creator_default BEFORE INSERT ON public.assets FOR EACH ROW EXECUTE FUNCTION collaboration.asset_creator_default();

CREATE TABLE collaboration.teams (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE collaboration.team_members (
 team_id text NOT NULL REFERENCES collaboration.teams(id) ON DELETE RESTRICT,
 user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN ('EDITOR','VIEWER')),
 created_by text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,user_id)
);
CREATE INDEX team_members_user ON collaboration.team_members(user_id,team_id);
CREATE TABLE collaboration.project_members (
 project_id text NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN ('EDITOR','VIEWER')),
 created_by text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,user_id)
);
CREATE INDEX project_members_user ON collaboration.project_members(user_id,project_id);
CREATE TABLE collaboration.project_teams (
 project_id text NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 team_id text NOT NULL REFERENCES collaboration.teams(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN ('EDITOR','VIEWER')),
 created_by text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,team_id)
);
CREATE INDEX project_teams_team ON collaboration.project_teams(team_id,project_id);

CREATE FUNCTION collaboration.team_role(tid text,actor text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN t.owner_id=actor THEN 'OWNER' ELSE m.role END
 FROM collaboration.teams t LEFT JOIN collaboration.team_members m ON m.team_id=t.id AND m.user_id=actor
 WHERE t.id=tid AND t.deleted_at IS NULL AND EXISTS(SELECT 1 FROM public.users u WHERE u.id=actor AND NOT u.disabled)
$$;
CREATE FUNCTION collaboration.project_role(pid text,actor text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p.owner_id=actor THEN 'OWNER' ELSE CASE GREATEST(
 COALESCE((SELECT CASE pm.role WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END FROM collaboration.project_members pm WHERE pm.project_id=p.id AND pm.user_id=actor),0),
 COALESCE((SELECT max(LEAST(CASE collaboration.team_role(pt.team_id,actor) WHEN 'OWNER' THEN 3 WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END,CASE pt.role WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 1 ELSE 0 END)) FROM collaboration.project_teams pt WHERE pt.project_id=p.id),0)) WHEN 2 THEN 'EDITOR' WHEN 1 THEN 'VIEWER' END END
 FROM public.projects p WHERE p.id=pid AND p.deleted_at IS NULL AND p.internal_kind IS NULL AND EXISTS(SELECT 1 FROM public.users u WHERE u.id=actor AND NOT u.disabled)
$$;

CREATE TABLE collaboration.audit (
 id bigserial PRIMARY KEY, actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 action text NOT NULL, resource_kind text NOT NULL, resource_id text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collaboration_audit_resource ON collaboration.audit(resource_kind,resource_id,id);

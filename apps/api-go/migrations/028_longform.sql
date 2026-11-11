-- Optional SGUN longform projects retain actor-scoped cloud identity, durable
-- request receipts and immutable STUDIO output assets independently of v1 graphs.
CREATE SCHEMA longform;
ALTER TABLE canvas.node_versions ADD COLUMN incarnation bigint NOT NULL DEFAULT 1 CHECK(incarnation>0);
CREATE FUNCTION longform.track_incarnation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT OLD.present AND NEW.present THEN NEW.incarnation:=OLD.incarnation+1; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER longform_node_incarnation BEFORE UPDATE ON canvas.node_versions FOR EACH ROW EXECUTE FUNCTION longform.track_incarnation();
CREATE TABLE longform.projects (
 id uuid PRIMARY KEY,
 actor_id text NOT NULL REFERENCES public.users(id),
 owner_id text NOT NULL REFERENCES public.users(id),
 canvas_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
 node_id text NOT NULL,
 node_version bigint NOT NULL,
 node_incarnation bigint NOT NULL,
 remote_id uuid,
 snapshot jsonb,
 create_body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(canvas_id,node_id)
);
CREATE TABLE longform.requests (
 project_id uuid NOT NULL REFERENCES longform.projects(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 body jsonb NOT NULL,
 response jsonb,
 rejected_code text,
 rejected_status integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,request_id)
);
CREATE TABLE longform.read_grants (
 id text PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES longform.projects(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES public.users(id),
 asset_id text NOT NULL REFERENCES public.assets(id),
 source_version text NOT NULL,
 checksum_sha256 text NOT NULL CHECK(length(checksum_sha256)=64),
 expires_at timestamptz NOT NULL
);
CREATE TABLE longform.artifacts (
 project_id uuid NOT NULL REFERENCES longform.projects(id) ON DELETE CASCADE,
 artifact_id uuid NOT NULL,
 asset_id text NOT NULL REFERENCES public.assets(id),
 composition boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,artifact_id)
);
CREATE INDEX longform_projects_actor ON longform.projects(actor_id,updated_at DESC);

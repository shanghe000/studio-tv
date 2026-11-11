-- Explicit publications pin immutable source assets without changing their
-- personal owner, library identity or blob. Imports create independent copies.
CREATE TABLE collaboration.team_folders (
 id text PRIMARY KEY,
 team_id text NOT NULL REFERENCES collaboration.teams(id),
 parent_id text,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 120),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by text NOT NULL REFERENCES public.users(id),
 updated_by text NOT NULL REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 UNIQUE(id,team_id),
 FOREIGN KEY(parent_id,team_id) REFERENCES collaboration.team_folders(id,team_id),
 CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE INDEX team_folders_page ON collaboration.team_folders(team_id,parent_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE collaboration.team_entries (
 id text PRIMARY KEY,
 team_id text NOT NULL REFERENCES collaboration.teams(id),
 folder_id text,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 120),
 kind text NOT NULL CHECK(kind IN('ASSET','NODE')),
 source_kind text NOT NULL CHECK(source_kind IN('ASSET','NODE')),
 source_id text NOT NULL,
 source_version text NOT NULL,
 source_owner_id text NOT NULL REFERENCES public.users(id),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 thumbnail_asset_id text,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by text NOT NULL REFERENCES public.users(id),
 updated_by text NOT NULL REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 UNIQUE(id,team_id),
 FOREIGN KEY(folder_id,team_id) REFERENCES collaboration.team_folders(id,team_id)
);
CREATE INDEX team_entries_page ON collaboration.team_entries(team_id,folder_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE collaboration.team_asset_refs (
 entry_id text NOT NULL,
 team_id text NOT NULL,
 asset_id text NOT NULL,
 asset_owner_id text NOT NULL,
 sort_order integer NOT NULL CHECK(sort_order BETWEEN 0 AND 499),
 PRIMARY KEY(entry_id,asset_id),
 UNIQUE(entry_id,sort_order),
 FOREIGN KEY(entry_id,team_id) REFERENCES collaboration.team_entries(id,team_id),
 FOREIGN KEY(asset_id,asset_owner_id) REFERENCES public.assets(id,owner_id)
);
CREATE INDEX team_asset_refs_grant ON collaboration.team_asset_refs(asset_id,team_id,entry_id);
ALTER TABLE collaboration.team_entries ADD CONSTRAINT team_entry_thumbnail_ref
 FOREIGN KEY(id,thumbnail_asset_id) REFERENCES collaboration.team_asset_refs(entry_id,asset_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE collaboration.asset_import_receipts (
 actor_id text NOT NULL REFERENCES public.users(id),
 project_id text NOT NULL REFERENCES public.projects(id),
 operation text NOT NULL,
 key_hash text NOT NULL CHECK(length(key_hash)=64),
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,project_id,operation,key_hash)
);
CREATE FUNCTION collaboration.guard_team_asset_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision<=OLD.revision OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
  RAISE EXCEPTION 'team asset identity/revision is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER team_folder_identity BEFORE UPDATE ON collaboration.team_folders FOR EACH ROW EXECUTE FUNCTION collaboration.guard_team_asset_identity();
CREATE TRIGGER team_entry_identity BEFORE UPDATE ON collaboration.team_entries FOR EACH ROW EXECUTE FUNCTION collaboration.guard_team_asset_identity();
CREATE FUNCTION collaboration.guard_team_entry_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.kind,NEW.source_kind,NEW.source_id,NEW.source_version,NEW.source_owner_id,NEW.content,NEW.thumbnail_asset_id) IS DISTINCT FROM ROW(OLD.kind,OLD.source_kind,OLD.source_id,OLD.source_version,OLD.source_owner_id,OLD.content,OLD.thumbnail_asset_id) THEN
  RAISE EXCEPTION 'team publication source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER team_entry_source BEFORE UPDATE ON collaboration.team_entries FOR EACH ROW EXECUTE FUNCTION collaboration.guard_team_entry_source();

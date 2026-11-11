-- Owner-only project organization and real persisted inbox. No users or messages seeded.
CREATE SCHEMA organization;
CREATE TABLE organization.collections (
 owner_id text PRIMARY KEY REFERENCES public.users(id),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE organization.project_folders (
 id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES organization.collections(owner_id),
 parent_id text,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 100),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 UNIQUE(id,owner_id),
 FOREIGN KEY(parent_id,owner_id) REFERENCES organization.project_folders(id,owner_id),
 CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE INDEX project_folders_owner_page ON organization.project_folders(owner_id,parent_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE organization.project_memberships (
 project_id text PRIMARY KEY,
 owner_id text NOT NULL,
 folder_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id),
 FOREIGN KEY(folder_id,owner_id) REFERENCES organization.project_folders(id,owner_id)
);
CREATE INDEX project_memberships_folder ON organization.project_memberships(owner_id,folder_id,project_id);
CREATE VIEW organization.visible_folders AS WITH RECURSIVE tree AS (
 SELECT f.*,1 AS level FROM organization.project_folders f WHERE f.parent_id IS NULL AND f.deleted_at IS NULL
 UNION ALL SELECT f.*,p.level+1 FROM organization.project_folders f JOIN tree p ON f.parent_id=p.id AND f.owner_id=p.owner_id WHERE f.deleted_at IS NULL
) SELECT * FROM tree;
CREATE FUNCTION organization.guard_folder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_level integer; subtree_depth integer;
BEGIN
 -- Shape changes serialize through the owner. Revision-only invalidation also
 -- comes from core project/asset transactions and must not invert lock order.
 IF TG_OP='INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.name IS DISTINCT FROM OLD.name OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('organization:folders:'||NEW.owner_id,0));
 END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision<=OLD.revision OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)) THEN
  RAISE EXCEPTION 'folder identity/revision/deletion violation' USING ERRCODE='23514';
 END IF;
 IF NEW.deleted_at IS NULL THEN
  IF NEW.parent_id IS NULL THEN parent_level:=0;
  ELSE SELECT level INTO parent_level FROM organization.visible_folders WHERE id=NEW.parent_id AND owner_id=NEW.owner_id;
   IF parent_level IS NULL THEN RAISE EXCEPTION 'active owner parent required' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
   WITH RECURSIVE children(id,depth) AS (SELECT OLD.id,1 UNION ALL SELECT f.id,c.depth+1 FROM organization.project_folders f JOIN children c ON f.parent_id=c.id WHERE f.owner_id=NEW.owner_id AND f.deleted_at IS NULL)
   SELECT max(depth) INTO subtree_depth FROM children;
   IF EXISTS(WITH RECURSIVE children(id) AS (SELECT OLD.id UNION ALL SELECT f.id FROM organization.project_folders f JOIN children c ON f.parent_id=c.id WHERE f.owner_id=NEW.owner_id AND f.deleted_at IS NULL) SELECT 1 FROM children WHERE id=NEW.parent_id) THEN
    RAISE EXCEPTION 'folder cycle rejected' USING ERRCODE='23514';
   END IF;
  ELSE subtree_depth:=1;
   IF (SELECT count(*) FROM organization.visible_folders WHERE owner_id=NEW.owner_id)>=1000 THEN RAISE EXCEPTION 'folder limit exceeded' USING ERRCODE='23514'; END IF;
  END IF;
  IF parent_level+subtree_depth>3 THEN RAISE EXCEPTION 'folder depth exceeded' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_folder_guard BEFORE INSERT OR UPDATE ON organization.project_folders FOR EACH ROW EXECUTE FUNCTION organization.guard_folder();
CREATE FUNCTION organization.guard_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('organization:folders:'||NEW.owner_id,0));
 IF TG_OP='UPDATE' AND (NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN RAISE EXCEPTION 'membership identity immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=NEW.project_id AND owner_id=NEW.owner_id AND deleted_at IS NULL AND internal_kind IS NULL) OR NOT EXISTS(SELECT 1 FROM organization.visible_folders WHERE id=NEW.folder_id AND owner_id=NEW.owner_id) THEN
  RAISE EXCEPTION 'active ordinary owner project and folder required' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_membership_guard BEFORE INSERT OR UPDATE ON organization.project_memberships FOR EACH ROW EXECUTE FUNCTION organization.guard_membership();
-- The ordinary project's core save/rename/delete and asset readiness changes
-- invalidate derived folder counts/bytes and collection representations too.
-- Ancestors are locked in stable id order; revision-only guard updates do not
-- acquire the organization advisory lock after the core already holds a row.
CREATE FUNCTION organization.invalidate_project(project_ref text,owner_ref text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE folder_ref text;
BEGIN
 FOR folder_ref IN WITH RECURSIVE ancestors(id,parent_id) AS (
  SELECT f.id,f.parent_id FROM organization.project_folders f JOIN organization.project_memberships m ON m.folder_id=f.id AND m.owner_id=f.owner_id WHERE m.project_id=project_ref AND m.owner_id=owner_ref
  UNION SELECT f.id,f.parent_id FROM organization.project_folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.owner_id=owner_ref
 ) SELECT id FROM ancestors ORDER BY id LOOP
  UPDATE organization.project_folders SET revision=revision+1,updated_at=now() WHERE id=folder_ref AND owner_id=owner_ref AND deleted_at IS NULL;
 END LOOP;
 INSERT INTO organization.collections(owner_id,revision) VALUES(owner_ref,2) ON CONFLICT(owner_id) DO UPDATE SET revision=organization.collections.revision+1;
END $$;
CREATE FUNCTION organization.project_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.internal_kind IS NULL AND NEW.deleted_at IS NULL THEN PERFORM organization.invalidate_project(NEW.id,NEW.owner_id); END IF;
 ELSIF NEW.internal_kind IS NULL OR OLD.internal_kind IS NULL THEN
  PERFORM organization.invalidate_project(NEW.id,NEW.owner_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_project_change AFTER INSERT OR UPDATE OF name,graph,cover_asset_id,pinned,revision,updated_at,deleted_at,internal_kind ON public.projects FOR EACH ROW EXECUTE FUNCTION organization.project_changed();
CREATE FUNCTION organization.asset_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.projects WHERE id=NEW.project_id AND owner_id=NEW.owner_id AND internal_kind IS NULL) THEN PERFORM organization.invalidate_project(NEW.project_id,NEW.owner_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_asset_change AFTER INSERT OR UPDATE OF byte_size,state,deleted_at ON public.assets FOR EACH ROW EXECUTE FUNCTION organization.asset_changed();
CREATE TABLE organization.notifications (
 id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES public.users(id),
 type text NOT NULL CHECK(type IN ('UPDATE_RECORD','OFFICIAL_MESSAGE','GENERATION')),
 title jsonb NOT NULL CHECK(jsonb_typeof(title)='object'),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 target_url text CHECK(target_url IS NULL OR (target_url LIKE 'https://%' AND length(target_url)<=4096)),
 source_kind text NOT NULL,
 source_ref text NOT NULL,
 read_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 UNIQUE(owner_id,source_kind,source_ref)
);
CREATE INDEX notifications_owner_page ON organization.notifications(owner_id,type,created_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX notifications_unread ON organization.notifications(owner_id,type) WHERE deleted_at IS NULL AND read_at IS NULL;
CREATE FUNCTION organization.guard_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision<=OLD.revision OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN RAISE EXCEPTION 'notification identity/revision/deletion violation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_guard BEFORE UPDATE ON organization.notifications FOR EACH ROW EXECUTE FUNCTION organization.guard_notification();
-- Emitted inside the same real task transaction; a receipt/read retry cannot invent one.
CREATE FUNCTION organization.task_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zh_title text; en_title text;
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('SUCCEEDED','FAILED','CANCELED') THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('organization:inbox:'||NEW.owner_id,0));
  zh_title:=CASE NEW.state WHEN 'SUCCEEDED' THEN '生成任务已完成' WHEN 'FAILED' THEN '生成任务失败' ELSE '生成任务已取消' END;
  en_title:=CASE NEW.state WHEN 'SUCCEEDED' THEN 'Generation completed' WHEN 'FAILED' THEN 'Generation failed' ELSE 'Generation canceled' END;
  INSERT INTO organization.notifications(id,owner_id,type,title,body,source_kind,source_ref)
  VALUES('ntf_'||md5(NEW.owner_id||':TASK:'||NEW.id),NEW.owner_id,'GENERATION',jsonb_build_object('zh-CN',zh_title,'en',en_title),jsonb_build_object('zh-CN',zh_title||'：'||NEW.id,'en',en_title||': '||NEW.id),'TASK',NEW.id)
  ON CONFLICT(owner_id,source_kind,source_ref) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_inbox_terminal AFTER UPDATE OF state ON execution.tasks FOR EACH ROW EXECUTE FUNCTION organization.task_notification();

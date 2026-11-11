-- Minimal private ROLE/SCENE gallery slice. No curated/public catalog seed.
-- Applies after the existing core migrations; 004's project owner key is untouched.
CREATE SCHEMA library;
ALTER TABLE public.assets ADD CONSTRAINT studio_assets_id_owner_uq UNIQUE(id,owner_id);

CREATE TABLE library.collections (
  owner_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE library.items (
  id text PRIMARY KEY CHECK(char_length(id) BETWEEN 1 AND 200),
  owner_id text NOT NULL REFERENCES library.collections(owner_id) ON DELETE RESTRICT,
  title text NOT NULL CHECK(char_length(btrim(title))>=1 AND char_length(title)<=120),
  description text NOT NULL DEFAULT '' CHECK(char_length(description)<=2000),
  kind text NOT NULL CHECK(kind IN ('ROLE','SCENE')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,owner_id)
);
CREATE INDEX library_items_owner_page_idx ON library.items(owner_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX library_items_owner_kind_page_idx ON library.items(owner_id,kind,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE library.item_media_refs (
  item_id text NOT NULL,
  owner_id text NOT NULL,
  asset_id text NOT NULL,
  sort_order integer NOT NULL CHECK(sort_order BETWEEN 0 AND 99),
  is_main boolean NOT NULL DEFAULT false,
  PRIMARY KEY(item_id,asset_id),
  UNIQUE(item_id,sort_order),
  CONSTRAINT library_refs_item_owner_fk FOREIGN KEY(item_id,owner_id) REFERENCES library.items(id,owner_id) ON DELETE RESTRICT,
  CONSTRAINT library_refs_asset_owner_fk FOREIGN KEY(asset_id,owner_id) REFERENCES public.assets(id,owner_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX library_refs_main_uq ON library.item_media_refs(item_id) WHERE is_main;
CREATE INDEX library_refs_asset_idx ON library.item_media_refs(asset_id,owner_id);
CREATE FUNCTION library.guard_item_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'library identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.revision<=OLD.revision OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'library revision must advance and deletion cannot regress' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER library_items_identity_guard BEFORE UPDATE ON library.items FOR EACH ROW EXECUTE FUNCTION library.guard_item_identity();
-- READY/state/deleted_at IMAGE checks are runtime authorization, not an unsafe
-- cross-table CHECK. Repository transactions lock assets against concurrent writes.

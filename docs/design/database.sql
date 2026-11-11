-- Studio TV PostgreSQL 17 DDD database blueprint, 2026-10-05.
-- DESIGN ONLY: not an application migration; never loaded by cmd/migrate.
-- Run only in a disposable database AFTER existing 001, 002, 003 migrations.
-- P1 = catalog/library/canvas/voice foundation; P2 = execution/history/Canvas Agent;
-- P3 = model bundles, HyperFrames/Director studios and HF Agent integration.
-- All newly defined HTTP capabilities remain RESERVED until separately implemented.
-- Existing users, sessions, projects, assets and uploads are reused. Legacy
-- ipac_workspaces/project.workspace_id stay untouched and never authorize new data.
-- @catalog is an internal owner key for curated roots, never a user/tenant/workspace.
-- Domain IDs are text; revisions bigint; timestamps UTC timestamptz; money/payment absent.
-- P3 optional evolution: allow assets.project_id=NULL for owner-only HF/library
-- sources after updating source-aware owner validation and adding new upload
-- contracts. This blueprint DOES NOT drop the current NOT NULL constraint or
-- claim that frozen core asset-uploads currently accepts an independent HF root.

BEGIN;

CREATE SCHEMA media;
CREATE SCHEMA canvas;
CREATE SCHEMA catalog;
CREATE SCHEMA library;
CREATE SCHEMA execution;
CREATE SCHEMA assistant;
CREATE SCHEMA studio;
CREATE SCHEMA platform;

-- Existing owner IDs must never collide with the reserved catalog owner key.
ALTER TABLE public.users ADD CONSTRAINT studio_users_reserved_owner_ck CHECK (id <> '@catalog');
ALTER TABLE public.projects ADD CONSTRAINT studio_projects_id_owner_uq UNIQUE (id, owner_id);
ALTER TABLE public.assets ADD CONSTRAINT studio_assets_id_owner_uq UNIQUE (id, owner_id);
-- Before a real rollout, audit legacy rows for owner mismatches. Current v1
-- handlers already check owner; these additive constraints strengthen storage.
ALTER TABLE public.assets ADD CONSTRAINT studio_assets_project_owner_fk
  FOREIGN KEY (project_id,owner_id) REFERENCES public.projects(id,owner_id) ON DELETE RESTRICT;
ALTER TABLE public.asset_uploads ADD CONSTRAINT studio_asset_uploads_asset_owner_fk
  FOREIGN KEY (asset_id,owner_id) REFERENCES public.assets(id,owner_id) ON DELETE RESTRICT;

CREATE FUNCTION platform.valid_relative_path(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT char_length(p) BETWEEN 1 AND 1024
     AND p !~ '^/' AND p !~ '\\' AND p !~ ':'
     AND p !~ '(^|/)\.\.(/|$)' AND p !~ '(^|/)\.(/|$)'
     AND p !~ '//' AND p !~ '/$';
$$;

CREATE FUNCTION platform.reject_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published version/output rows are retained and immutable; insert a new version'
    USING ERRCODE = '23514';
END;
$$;

-- P1. Physical object directory: no browser blob CRUD, no authorization from blob ID.
-- PRIVATE roots own blobs; curated roots use @catalog. No signed URLs/secrets stored.
CREATE TABLE media.blobs (
  id text PRIMARY KEY,
  owner_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_key text GENERATED ALWAYS AS (coalesce(owner_id, '@catalog')) STORED,
  scope text NOT NULL CHECK (scope IN ('PRIVATE', 'CURATED')),
  backend text NOT NULL DEFAULT 'LOCAL' CHECK (backend IN ('LOCAL', 'S3')),
  bucket text NOT NULL DEFAULT '',
  object_key text NOT NULL,
  object_version text NOT NULL DEFAULT '',
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'STAGING' CHECK (state IN ('STAGING', 'READY', 'REJECTED', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (id, owner_key),
  UNIQUE (backend, bucket, object_key, object_version),
  CHECK ((scope = 'PRIVATE' AND owner_id IS NOT NULL) OR (scope = 'CURATED' AND owner_id IS NULL)),
  CHECK ((state = 'READY' AND verified_at IS NOT NULL) OR state <> 'READY')
);
CREATE INDEX blobs_owner_created_idx ON media.blobs(owner_key, created_at DESC, id) WHERE deleted_at IS NULL;

-- Nullable bridge: no current file moves/backfill are performed by this blueprint.
-- Existing assets keep storage_key and remain valid with blob_id=NULL. Production
-- rollout must copy/register existing verified objects before switching readers.
ALTER TABLE public.assets ADD COLUMN blob_id text;
ALTER TABLE public.assets ADD CONSTRAINT studio_assets_blob_owner_fk
  FOREIGN KEY (blob_id, owner_id) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT;
CREATE INDEX assets_blob_idx ON public.assets(blob_id) WHERE blob_id IS NOT NULL;

-- P3. Separate bundle aggregate; never widen existing Asset.kind enums.
-- Frozen ModelAsset supports only GLB/GLTF; richer formats use a new DTO extension.
CREATE TABLE media.model_assets (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  project_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  format text NOT NULL CHECK (format IN ('GLB', 'GLTF', 'OBJ', 'FBX', 'SPZ', 'PLY', 'SPLAT')),
  entrypoint text NOT NULL CHECK (platform.valid_relative_path(entrypoint)),
  preview_asset_id text,
  state text NOT NULL DEFAULT 'UPLOADING' CHECK (state IN ('UPLOADING', 'PROCESSING', 'READY', 'REJECTED', 'DELETED')),
  byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES public.projects(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (preview_asset_id, owner_id) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT
);
CREATE INDEX model_assets_owner_project_idx ON media.model_assets(owner_id, project_id, created_at DESC, id) WHERE deleted_at IS NULL;

CREATE TABLE media.model_files (
  model_asset_id text NOT NULL,
  owner_id text NOT NULL,
  path text NOT NULL CHECK (platform.valid_relative_path(path)),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  blob_id text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'READY', 'REJECTED')),
  PRIMARY KEY (model_asset_id, path),
  FOREIGN KEY (model_asset_id, owner_id) REFERENCES media.model_assets(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (blob_id, owner_id) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT,
  CHECK (state <> 'READY' OR blob_id IS NOT NULL)
);
CREATE INDEX model_files_blob_idx ON media.model_files(blob_id) WHERE blob_id IS NOT NULL;

CREATE TABLE media.model_uploads (
  id text PRIMARY KEY,
  model_asset_id text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  grant_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  complete_deadline_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (model_asset_id, owner_id) REFERENCES media.model_assets(id, owner_id) ON DELETE RESTRICT,
  CHECK (complete_deadline_at >= expires_at)
);
CREATE INDEX model_uploads_expiry_idx ON media.model_uploads(complete_deadline_at) WHERE completed_at IS NULL;

-- P1. Tag definitions are user aggregate children; node assignments stay in graph.
CREATE TABLE canvas.tag_sets (
  owner_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE canvas.tags (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES canvas.tag_sets(owner_id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  color text NOT NULL CHECK (color ~ '^#[a-fA-F0-9]{6}$'),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_id)
);
CREATE INDEX tags_owner_sort_idx ON canvas.tags(owner_id, sort_order, id) WHERE deleted_at IS NULL;

-- Graph/cover reference projection, refreshed in the same snapshot transaction.
-- Replaces graph::text LIKE lookup; graph remains the single editable source.
CREATE TABLE canvas.media_refs (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  owner_id text NOT NULL,
  node_key text NOT NULL DEFAULT '',
  ref_kind text NOT NULL CHECK (ref_kind IN ('NODE', 'COVER')),
  asset_id text,
  model_asset_id text,
  FOREIGN KEY (project_id, owner_id) REFERENCES public.projects(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, owner_id) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (model_asset_id, owner_id) REFERENCES media.model_assets(id, owner_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(asset_id, model_asset_id) = 1),
  CHECK ((ref_kind = 'NODE' AND node_key <> '') OR (ref_kind = 'COVER' AND node_key = '' AND asset_id IS NOT NULL))
);
CREATE UNIQUE INDEX canvas_media_asset_uq ON canvas.media_refs(project_id, node_key, ref_kind, asset_id) WHERE asset_id IS NOT NULL;
CREATE UNIQUE INDEX canvas_media_model_uq ON canvas.media_refs(project_id, node_key, ref_kind, model_asset_id) WHERE model_asset_id IS NOT NULL;
CREATE INDEX canvas_media_asset_reverse_idx ON canvas.media_refs(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX canvas_media_model_reverse_idx ON canvas.media_refs(model_asset_id) WHERE model_asset_id IS NOT NULL;

-- P1. Catalog media is curated content only. Importing to a canvas copies/registers
-- a READY private Asset/ModelAsset; arbitrary remote URLs are never asset identity.
CREATE TABLE catalog.media (
  id text PRIMARY KEY,
  blob_id text NOT NULL,
  blob_owner_key text NOT NULL DEFAULT '@catalog' CHECK (blob_owner_key = '@catalog'),
  kind text NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO', 'AUDIO', 'MODEL_3D', 'DOCUMENT', 'FONT', 'ANIMATION')),
  title text NOT NULL DEFAULT '',
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  duration_ms bigint CHECK (duration_ms >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (blob_id, blob_owner_key) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT
);
CREATE INDEX catalog_media_blob_idx ON catalog.media(blob_id);

-- Typed taxonomy namespaces, not arbitrary property EAV. CHARACTER_FILTER rows
-- form group/category trees; only leaf categories have ui_type and filter_options.
CREATE TABLE catalog.categories (
  id text PRIMARY KEY,
  namespace text NOT NULL CHECK (namespace IN ('CHARACTER_FILTER', 'WORKFLOW', 'PROMPT', 'SKILL', 'APP_TAG', 'DIRECTOR_MODEL', 'ANIMATION')),
  node_role text NOT NULL DEFAULT 'CATEGORY' CHECK (node_role IN ('GROUP','CATEGORY')),
  code text NOT NULL,
  parent_id text,
  name_localized jsonb NOT NULL CHECK (jsonb_typeof(name_localized) = 'object'),
  scope text CHECK (scope IN ('IMAGE', 'VIDEO')),
  menu_type text,
  ui_type text CHECK (ui_type IN ('TAB', 'COLOR', 'DROPDOWN')),
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (namespace, node_role, code),
  UNIQUE (id, namespace),
  UNIQUE (id, namespace, node_role),
  FOREIGN KEY (parent_id, namespace) REFERENCES catalog.categories(id, namespace) ON DELETE RESTRICT,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (ui_type IS NULL OR namespace = 'CHARACTER_FILTER')
);
CREATE INDEX categories_parent_sort_idx ON catalog.categories(namespace, parent_id, sort_order, id);

CREATE TABLE catalog.filter_options (
  category_id text NOT NULL,
  category_namespace text NOT NULL DEFAULT 'CHARACTER_FILTER' CHECK (category_namespace = 'CHARACTER_FILTER'),
  category_node_role text NOT NULL DEFAULT 'CATEGORY' CHECK (category_node_role = 'CATEGORY'),
  code text NOT NULL CHECK (code <> 'all'),
  name_localized jsonb NOT NULL CHECK (jsonb_typeof(name_localized) = 'object'),
  color_value text CHECK (color_value IS NULL OR color_value ~ '^#[a-fA-F0-9]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  filter_only boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (category_id, code),
  FOREIGN KEY (category_id, category_namespace, category_node_role) REFERENCES catalog.categories(id, namespace, node_role) ON DELETE RESTRICT
);

CREATE TABLE catalog.characters (
  id text PRIMARY KEY,
  owner_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_key text GENERATED ALWAYS AS (coalesce(owner_id, '@catalog')) STORED,
  scope text NOT NULL DEFAULT 'CURATED' CHECK (scope IN ('CURATED', 'PRIVATE')),
  name_localized jsonb NOT NULL CHECK (jsonb_typeof(name_localized) = 'object'),
  description_localized jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(description_localized) = 'object'),
  search_text text NOT NULL DEFAULT '',
  version text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_key),
  CHECK ((scope = 'PRIVATE' AND owner_id IS NOT NULL) OR (scope = 'CURATED' AND owner_id IS NULL))
);
CREATE INDEX characters_scope_sort_idx ON catalog.characters(scope, status, sort_order, id) WHERE deleted_at IS NULL;

CREATE TABLE catalog.character_attributes (
  character_id text NOT NULL,
  character_owner_key text NOT NULL,
  category_id text NOT NULL,
  option_code text NOT NULL,
  PRIMARY KEY (character_id, category_id, option_code),
  FOREIGN KEY (character_id, character_owner_key) REFERENCES catalog.characters(id, owner_key) ON DELETE RESTRICT,
  FOREIGN KEY (category_id, option_code) REFERENCES catalog.filter_options(category_id, code) ON DELETE RESTRICT
);
CREATE INDEX character_attributes_filter_idx ON catalog.character_attributes(category_id, option_code, character_id);

CREATE TABLE catalog.character_images (
  id text PRIMARY KEY,
  character_id text NOT NULL,
  character_owner_key text NOT NULL,
  name text NOT NULL,
  image_type text NOT NULL CHECK (image_type IN ('closeUp', 'fullBody', 'multiView', 'other')),
  catalog_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  asset_id text,
  sort_order integer NOT NULL DEFAULT 0,
  FOREIGN KEY (character_id, character_owner_key) REFERENCES catalog.characters(id, owner_key) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, character_owner_key) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(catalog_media_id, asset_id) = 1)
);
CREATE INDEX character_images_order_idx ON catalog.character_images(character_id, sort_order, id);

CREATE TABLE catalog.character_favorites (
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  character_id text NOT NULL,
  character_owner_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, character_id),
  FOREIGN KEY (character_id, character_owner_key) REFERENCES catalog.characters(id, owner_key) ON DELETE RESTRICT,
  CHECK (character_owner_key IN (owner_id, '@catalog'))
);
CREATE INDEX character_favorites_recent_idx ON catalog.character_favorites(owner_id, created_at DESC, character_id);

-- P1. Stable model identity + typed capabilities + immutable dynamic config.
-- provider_key/executor_key refer to server-side adapters/config, never secrets.
CREATE TABLE catalog.models (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name_localized jsonb NOT NULL CHECK (jsonb_typeof(name_localized) = 'object'),
  description_localized jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(description_localized) = 'object'),
  icon_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  provider_key text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog.model_groups (
  id text PRIMARY KEY,
  parent_id text REFERENCES catalog.model_groups(id) ON DELETE RESTRICT,
  code text NOT NULL UNIQUE,
  name_localized jsonb NOT NULL CHECK (jsonb_typeof(name_localized) = 'object'),
  icon_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL DEFAULT 0,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX model_groups_parent_idx ON catalog.model_groups(parent_id, sort_order, id);

CREATE TABLE catalog.model_capabilities (
  id text PRIMARY KEY,
  model_id text NOT NULL REFERENCES catalog.models(id) ON DELETE RESTRICT,
  node_type text NOT NULL,
  active_version text NOT NULL,
  available boolean NOT NULL DEFAULT false,
  unavailable_reason text,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (model_id, node_type)
);
CREATE INDEX model_capabilities_type_idx ON catalog.model_capabilities(node_type, available, sort_order, id);

CREATE TABLE catalog.model_versions (
  capability_id text NOT NULL REFERENCES catalog.model_capabilities(id) ON DELETE RESTRICT,
  version text NOT NULL,
  parameter_schema jsonb NOT NULL CHECK (jsonb_typeof(parameter_schema) = 'object'),
  ui_config jsonb NOT NULL CHECK (jsonb_typeof(ui_config) = 'array'),
  default_params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(default_params) = 'object'),
  input_requirements jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(input_requirements) = 'array'),
  output_types jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(output_types) = 'array'),
  generate_counts integer[] NOT NULL DEFAULT ARRAY[1],
  executor_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capability_id, version),
  CHECK (cardinality(generate_counts) BETWEEN 1 AND 32 AND 0 < ALL(generate_counts))
);
ALTER TABLE catalog.model_capabilities ADD CONSTRAINT model_capabilities_active_version_fk
  FOREIGN KEY (id, active_version) REFERENCES catalog.model_versions(capability_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER model_versions_immutable BEFORE UPDATE OR DELETE ON catalog.model_versions
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

CREATE TABLE catalog.model_group_members (
  group_id text NOT NULL REFERENCES catalog.model_groups(id) ON DELETE RESTRICT,
  capability_id text NOT NULL REFERENCES catalog.model_capabilities(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, capability_id)
);

-- P1. Registry holds only shared identity/ownership. Typed immutable version
-- tables below hold workflow/prompt/skill/app/voice business data. This is NOT EAV.
-- Each remains its own domain aggregate and repository; favorites have a real FK.
CREATE TABLE catalog.resources (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('WORKFLOW', 'PROMPT', 'STYLE', 'SKILL', 'AI_APP', 'VOICE')),
  owner_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_key text GENERATED ALWAYS AS (coalesce(owner_id, '@catalog')) STORED,
  scope text NOT NULL CHECK (scope IN ('PRIVATE', 'CURATED')),
  name_localized jsonb NOT NULL CHECK (jsonb_typeof(name_localized) = 'object'),
  description_localized jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(description_localized) = 'object'),
  search_text text NOT NULL DEFAULT '',
  cover_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  cover_asset_id text,
  category_id text REFERENCES catalog.categories(id) ON DELETE RESTRICT,
  active_version text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  recommended boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_key),
  UNIQUE (id, owner_key, kind),
  FOREIGN KEY (cover_asset_id, owner_key) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(cover_media_id, cover_asset_id) <= 1),
  CHECK ((scope = 'PRIVATE' AND owner_id IS NOT NULL) OR (scope = 'CURATED' AND owner_id IS NULL))
);
CREATE INDEX resources_scope_kind_idx ON catalog.resources(scope, kind, status, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX resources_owner_kind_idx ON catalog.resources(owner_key, kind, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX resources_category_idx ON catalog.resources(category_id, kind, updated_at DESC, id) WHERE deleted_at IS NULL;

CREATE TABLE catalog.resource_category_links (
  resource_id text NOT NULL REFERENCES catalog.resources(id) ON DELETE RESTRICT,
  category_id text NOT NULL REFERENCES catalog.categories(id) ON DELETE RESTRICT,
  PRIMARY KEY (resource_id, category_id)
);
CREATE INDEX resource_category_reverse_idx ON catalog.resource_category_links(category_id, resource_id);

CREATE TABLE catalog.resource_user_states (
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  resource_id text NOT NULL,
  resource_owner_key text NOT NULL,
  favorited boolean NOT NULL DEFAULT false,
  favorited_at timestamptz,
  usage_count bigint NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  last_used_at timestamptz,
  PRIMARY KEY (owner_id, resource_id),
  FOREIGN KEY (resource_id, resource_owner_key) REFERENCES catalog.resources(id, owner_key) ON DELETE RESTRICT,
  CHECK (resource_owner_key IN (owner_id, '@catalog')),
  CHECK (NOT favorited OR favorited_at IS NOT NULL)
);
CREATE INDEX resource_user_favorites_idx ON catalog.resource_user_states(owner_id, favorited_at DESC, resource_id) WHERE favorited;
CREATE INDEX resource_user_recent_idx ON catalog.resource_user_states(owner_id, last_used_at DESC, resource_id) WHERE last_used_at IS NOT NULL;

CREATE TABLE catalog.workflow_versions (
  resource_id text NOT NULL,
  owner_key text NOT NULL,
  resource_kind text NOT NULL DEFAULT 'WORKFLOW' CHECK (resource_kind = 'WORKFLOW'),
  version text NOT NULL,
  graph jsonb NOT NULL CHECK (jsonb_typeof(graph) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, version),
  UNIQUE (resource_id, version, owner_key),
  FOREIGN KEY (resource_id, owner_key, resource_kind) REFERENCES catalog.resources(id, owner_key, kind) ON DELETE RESTRICT
);
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE OR DELETE ON catalog.workflow_versions
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

CREATE TABLE catalog.prompt_versions (
  resource_id text NOT NULL,
  owner_key text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('PROMPT', 'STYLE')),
  version text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('IMAGE','VIDEO','TEXT')),
  prompt_code text,
  prefix_prompt text NOT NULL DEFAULT '',
  suffix_prompt text NOT NULL DEFAULT '',
  hidden_content boolean NOT NULL DEFAULT false,
  reference_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  reference_asset_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, version),
  FOREIGN KEY (resource_id, owner_key, resource_kind) REFERENCES catalog.resources(id, owner_key, kind) ON DELETE RESTRICT,
  FOREIGN KEY (reference_asset_id, owner_key) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(reference_media_id, reference_asset_id) <= 1)
);
CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE OR DELETE ON catalog.prompt_versions
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

CREATE TABLE catalog.skill_versions (
  resource_id text NOT NULL,
  owner_key text NOT NULL,
  resource_kind text NOT NULL DEFAULT 'SKILL' CHECK (resource_kind = 'SKILL'),
  version text NOT NULL,
  scenario text NOT NULL DEFAULT '',
  guide text NOT NULL DEFAULT '',
  output_description text NOT NULL DEFAULT '',
  preset_prompt text NOT NULL DEFAULT '',
  output_type text NOT NULL CHECK (output_type IN ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'WORLD_3D', 'MODEL_3D', 'STRUCTURED')),
  output_samples jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(output_samples) = 'array'),
  sub_options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sub_options) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, version),
  UNIQUE (resource_id, version, owner_key),
  FOREIGN KEY (resource_id, owner_key, resource_kind) REFERENCES catalog.resources(id, owner_key, kind) ON DELETE RESTRICT
);
CREATE TRIGGER skill_versions_immutable BEFORE UPDATE OR DELETE ON catalog.skill_versions
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

CREATE TABLE catalog.skill_files (
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  owner_key text NOT NULL,
  path text NOT NULL CHECK (platform.valid_relative_path(path)),
  file_type text NOT NULL,
  primary_file boolean NOT NULL DEFAULT false,
  blob_id text NOT NULL,
  PRIMARY KEY (skill_id, skill_version, path),
  FOREIGN KEY (skill_id, skill_version, owner_key) REFERENCES catalog.skill_versions(resource_id, version, owner_key) ON DELETE RESTRICT,
  FOREIGN KEY (blob_id, owner_key) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX skill_files_primary_uq ON catalog.skill_files(skill_id, skill_version) WHERE primary_file;
CREATE INDEX skill_files_blob_idx ON catalog.skill_files(blob_id);
CREATE TRIGGER skill_files_immutable BEFORE UPDATE OR DELETE ON catalog.skill_files
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

CREATE TABLE catalog.app_versions (
  resource_id text NOT NULL,
  owner_key text NOT NULL,
  resource_kind text NOT NULL DEFAULT 'AI_APP' CHECK (resource_kind = 'AI_APP'),
  version text NOT NULL,
  workflow_id text NOT NULL,
  workflow_version text NOT NULL,
  workflow_owner_key text NOT NULL,
  inputs_schema jsonb NOT NULL CHECK (jsonb_typeof(inputs_schema) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, version),
  UNIQUE (resource_id, version, owner_key),
  FOREIGN KEY (resource_id, owner_key, resource_kind) REFERENCES catalog.resources(id, owner_key, kind) ON DELETE RESTRICT,
  FOREIGN KEY (workflow_id, workflow_version, workflow_owner_key) REFERENCES catalog.workflow_versions(resource_id, version, owner_key) ON DELETE RESTRICT,
  CHECK (workflow_owner_key IN (owner_key, '@catalog'))
);
CREATE TRIGGER app_versions_immutable BEFORE UPDATE OR DELETE ON catalog.app_versions
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

-- P1. Directory only; no voice cloning/training API implied.
CREATE TABLE catalog.voice_versions (
  resource_id text NOT NULL,
  owner_key text NOT NULL,
  resource_kind text NOT NULL DEFAULT 'VOICE' CHECK (resource_kind = 'VOICE'),
  version text NOT NULL,
  capability_id text REFERENCES catalog.model_capabilities(id) ON DELETE RESTRICT,
  provider_voice_code text NOT NULL,
  gender text NOT NULL CHECK (gender IN ('FEMALE', 'MALE', 'UNKNOWN')),
  language_codes text[] NOT NULL DEFAULT '{}',
  dialect_codes text[] NOT NULL DEFAULT '{}',
  scene_codes text[] NOT NULL DEFAULT '{}',
  preview_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, version),
  FOREIGN KEY (resource_id, owner_key, resource_kind) REFERENCES catalog.resources(id, owner_key, kind) ON DELETE RESTRICT
);
CREATE INDEX voice_versions_languages_idx ON catalog.voice_versions USING gin(language_codes);
CREATE INDEX voice_versions_scenes_idx ON catalog.voice_versions USING gin(scene_codes);
CREATE TRIGGER voice_versions_immutable BEFORE UPDATE OR DELETE ON catalog.voice_versions
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

-- Registry active_version must resolve to the correct typed table at commit.
-- This also guarantees a declared ACTIVE catalog item has a real immutable version.
CREATE FUNCTION catalog.verify_resource_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r catalog.resources%ROWTYPE; found_version boolean;
BEGIN
  SELECT * INTO r FROM catalog.resources WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  CASE r.kind
    WHEN 'WORKFLOW' THEN SELECT EXISTS(SELECT 1 FROM catalog.workflow_versions WHERE resource_id=r.id AND version=r.active_version) INTO found_version;
    WHEN 'PROMPT','STYLE' THEN SELECT EXISTS(SELECT 1 FROM catalog.prompt_versions WHERE resource_id=r.id AND version=r.active_version) INTO found_version;
    WHEN 'SKILL' THEN SELECT EXISTS(SELECT 1 FROM catalog.skill_versions WHERE resource_id=r.id AND version=r.active_version) INTO found_version;
    WHEN 'AI_APP' THEN SELECT EXISTS(SELECT 1 FROM catalog.app_versions WHERE resource_id=r.id AND version=r.active_version) INTO found_version;
    WHEN 'VOICE' THEN SELECT EXISTS(SELECT 1 FROM catalog.voice_versions WHERE resource_id=r.id AND version=r.active_version) INTO found_version;
  END CASE;
  IF NOT found_version THEN RAISE EXCEPTION 'resource % active version is missing', r.id USING ERRCODE='23503'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER resources_active_version_fk AFTER INSERT OR UPDATE ON catalog.resources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.verify_resource_version();

-- P1. Personal library. Classifications are NOT media kind; ALL is query-only.
-- The collections root serializes same-owner directory mutation/cycle checks.
CREATE TABLE library.collections (
  owner_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE library.folders (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES library.collections(owner_id) ON DELETE RESTRICT,
  parent_id text,
  category_code text NOT NULL CHECK (category_code IN ('USER_CHARACTER', 'USER_SCENE', 'USER_THING', 'USER_STYLE', 'USER_PRODUCT', 'USER_OTHER')),
  kind text NOT NULL DEFAULT 'MIXED' CHECK (kind IN ('MIXED','IMAGE', 'VIDEO', 'AUDIO', 'TEXT', 'MODEL_3D')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_id),
  UNIQUE (id, owner_id, kind),
  FOREIGN KEY (parent_id, owner_id) REFERENCES library.folders(id, owner_id) ON DELETE RESTRICT,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX folders_parent_idx ON library.folders(owner_id, parent_id, kind, category_code, updated_at DESC, id) WHERE deleted_at IS NULL;

-- P1. Explicit folder covers; never encode private asset IDs in an unchecked
-- JSONB array. Four deterministic slots mirror the native cover mosaic.
CREATE TABLE library.folder_media_refs (
  folder_id text NOT NULL,
  owner_id text NOT NULL,
  asset_id text NOT NULL,
  sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 3),
  PRIMARY KEY (folder_id,sort_order),
  UNIQUE (folder_id,asset_id),
  FOREIGN KEY (folder_id,owner_id) REFERENCES library.folders(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id,owner_id) REFERENCES public.assets(id,owner_id) ON DELETE RESTRICT
);
CREATE INDEX folder_media_asset_reverse_idx ON library.folder_media_refs(asset_id);

CREATE FUNCTION library.guard_folder_tree() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.owner_id <> OLD.owner_id OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'folder owner and media kind are immutable' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM library.collections WHERE owner_id=NEW.owner_id FOR UPDATE;
  IF NEW.parent_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM library.folders WHERE id=NEW.parent_id AND owner_id=NEW.owner_id AND (kind='MIXED' OR kind=NEW.kind) AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'parent folder is unavailable' USING ERRCODE='23503';
    END IF;
    IF EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id,parent_id FROM library.folders WHERE id=NEW.parent_id AND owner_id=NEW.owner_id
        UNION
        SELECT f.id,f.parent_id FROM library.folders f JOIN ancestors a ON f.id=a.parent_id WHERE f.owner_id=NEW.owner_id
      ) SELECT 1 FROM ancestors WHERE id=NEW.id
    ) THEN RAISE EXCEPTION 'folder cycle is forbidden' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER folders_tree_guard BEFORE INSERT OR UPDATE ON library.folders
  FOR EACH ROW EXECUTE FUNCTION library.guard_folder_tree();

CREATE TABLE library.items (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES library.collections(owner_id) ON DELETE RESTRICT,
  folder_id text,
  category_code text NOT NULL CHECK (category_code IN ('USER_CHARACTER', 'USER_SCENE', 'USER_THING', 'USER_STYLE', 'USER_PRODUCT', 'USER_OTHER')),
  kind text NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO', 'AUDIO', 'TEXT', 'MODEL_3D')),
  item_type text NOT NULL DEFAULT 'NODE' CHECK (item_type IN ('NODE', 'ROLE_GALLERY', 'SCENE_GALLERY')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  asset_id text,
  model_asset_id text,
  text_content text,
  node_content jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(node_content) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_id),
  FOREIGN KEY (folder_id, owner_id) REFERENCES library.folders(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, owner_id) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (model_asset_id, owner_id) REFERENCES media.model_assets(id, owner_id) ON DELETE RESTRICT,
  CHECK (
    (item_type <> 'NODE' AND kind='IMAGE' AND asset_id IS NULL AND model_asset_id IS NULL AND text_content IS NULL)
    OR (item_type='NODE' AND (
      (kind IN ('IMAGE','VIDEO','AUDIO') AND asset_id IS NOT NULL AND model_asset_id IS NULL AND text_content IS NULL)
      OR (kind='TEXT' AND text_content IS NOT NULL AND asset_id IS NULL AND model_asset_id IS NULL)
      OR (kind='MODEL_3D' AND model_asset_id IS NOT NULL AND asset_id IS NULL AND text_content IS NULL)
    ))
  )
);
CREATE INDEX items_folder_idx ON library.items(owner_id, folder_id, kind, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX items_type_idx ON library.items(owner_id, item_type, category_code, updated_at DESC, id) WHERE deleted_at IS NULL;

-- Ordered gallery images and reusable-node media dependencies share a real
-- relationship table. ROLE/SCENE gallery roots never become public Characters.
CREATE TABLE library.item_media_refs (
  id text PRIMARY KEY,
  item_id text NOT NULL,
  owner_id text NOT NULL,
  asset_id text,
  model_asset_id text,
  ref_role text NOT NULL CHECK (ref_role IN ('PRIMARY', 'GALLERY_IMAGE', 'REFERENCE', 'THUMBNAIL')),
  name text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  FOREIGN KEY (item_id, owner_id) REFERENCES library.items(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, owner_id) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (model_asset_id, owner_id) REFERENCES media.model_assets(id, owner_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(asset_id, model_asset_id) = 1)
);
CREATE UNIQUE INDEX item_primary_media_uq ON library.item_media_refs(item_id) WHERE ref_role='PRIMARY';
CREATE INDEX item_media_order_idx ON library.item_media_refs(item_id, sort_order, id);
CREATE INDEX item_media_asset_reverse_idx ON library.item_media_refs(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX item_media_model_reverse_idx ON library.item_media_refs(model_asset_id) WHERE model_asset_id IS NOT NULL;

-- P2. Tasks use our state machine, not unverified RunningHub task status values.
-- Submitted graphs/configs/inputs are immutable snapshots. Worker lease/fence
-- belongs to plans; external network calls occur OUTSIDE database transactions.
CREATE TABLE execution.tasks (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  project_id text NOT NULL,
  project_revision bigint NOT NULL CHECK (project_revision > 0),
  target_type text NOT NULL CHECK (target_type IN ('NODE', 'GROUP', 'CANVAS')),
  target_id text NOT NULL,
  executor_kind text NOT NULL CHECK (executor_kind IN ('MODEL', 'FFMPEG', 'SKETCHBOARD')),
  task_kind text NOT NULL,
  graph_snapshot jsonb NOT NULL CHECK (jsonb_typeof(graph_snapshot) = 'object'),
  source_app_id text,
  source_app_version text,
  source_app_owner_key text,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'PLANNING', 'AWAITING_CONFIRMATION', 'RUNNING', 'CANCEL_REQUESTED', 'SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED', 'CANCELED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  progress numeric(7,6) CHECK (progress BETWEEN 0 AND 1),
  phase text,
  execution_key text,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (id, owner_id),
  UNIQUE (id, owner_id, project_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES public.projects(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_app_id, source_app_version, source_app_owner_key) REFERENCES catalog.app_versions(resource_id, version, owner_key) MATCH FULL ON DELETE RESTRICT,
  CHECK (source_app_owner_key IS NULL OR source_app_owner_key IN (owner_id, '@catalog'))
);
CREATE UNIQUE INDEX tasks_execution_key_uq ON execution.tasks(owner_id, project_id, execution_key) WHERE execution_key IS NOT NULL;
CREATE INDEX tasks_owner_state_idx ON execution.tasks(owner_id, state, created_at DESC, id);
CREATE INDEX tasks_project_created_idx ON execution.tasks(project_id, created_at DESC, id);

CREATE TABLE execution.plans (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  owner_id text NOT NULL,
  project_id text NOT NULL,
  node_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  capability_id text,
  capability_version text,
  invocation_type text NOT NULL,
  executor_spec jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(executor_spec)='object'),
  params_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params_snapshot)='object'),
  node_config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(node_config_snapshot)='object'),
  attachments_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments_snapshot)='array'),
  output_count integer NOT NULL DEFAULT 1 CHECK (output_count BETWEEN 1 AND 256),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'SKIPPED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (id, task_id, owner_id),
  UNIQUE (id, task_id, owner_id, project_id),
  UNIQUE (task_id, node_id, position),
  FOREIGN KEY (task_id, owner_id, project_id) REFERENCES execution.tasks(id, owner_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (capability_id, capability_version) REFERENCES catalog.model_versions(capability_id, version) MATCH FULL ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX plans_dispatch_idx ON execution.plans(available_at, id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX plans_lease_idx ON execution.plans(lease_until, id) WHERE lease_until IS NOT NULL;

CREATE TABLE execution.dependencies (
  task_id text NOT NULL,
  owner_id text NOT NULL,
  plan_id text NOT NULL,
  depends_on_plan_id text NOT NULL,
  PRIMARY KEY (plan_id, depends_on_plan_id),
  FOREIGN KEY (plan_id, task_id, owner_id) REFERENCES execution.plans(id, task_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (depends_on_plan_id, task_id, owner_id) REFERENCES execution.plans(id, task_id, owner_id) ON DELETE RESTRICT,
  CHECK (plan_id <> depends_on_plan_id)
);
-- DAG cycle validation is planner domain logic in the task-creation transaction.
CREATE INDEX dependencies_reverse_idx ON execution.dependencies(depends_on_plan_id, plan_id);

CREATE TABLE execution.attempts (
  id text PRIMARY KEY,
  plan_id text NOT NULL,
  task_id text NOT NULL,
  owner_id text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  fence bigint NOT NULL CHECK (fence > 0),
  provider_key text NOT NULL,
  provider_task_id text,
  state text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED','SUBMITTED','RUNNING','SUCCEEDED','FAILED','CANCELED','UNKNOWN')),
  request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_snapshot)='object'),
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response_metadata)='object'),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (plan_id, attempt_no),
  UNIQUE (id, plan_id, task_id, owner_id),
  FOREIGN KEY (plan_id, task_id, owner_id) REFERENCES execution.plans(id, task_id, owner_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX attempts_provider_task_uq ON execution.attempts(provider_key, provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX attempts_unknown_idx ON execution.attempts(created_at, id) WHERE state='UNKNOWN';
-- A timeout after provider submission is UNKNOWN and must reconcile; never auto
-- resubmit a potentially charged operation merely because the worker lease expired.

CREATE TABLE execution.outputs (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  plan_id text NOT NULL,
  attempt_id text,
  owner_id text NOT NULL,
  project_id text NOT NULL,
  output_index integer NOT NULL CHECK (output_index >= 0),
  output_type text NOT NULL CHECK (output_type IN ('TEXT','IMAGE','VIDEO','AUDIO','MODEL_3D','WORLD_3D','SCRIPT','STORYBOARD')),
  state text NOT NULL CHECK (state IN ('SUCCEEDED','FAILED')),
  asset_id text,
  model_asset_id text,
  blob_id text,
  text_content text,
  structured_content jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, output_index),
  UNIQUE (id, owner_id, project_id),
  UNIQUE (id, owner_id, project_id, plan_id),
  FOREIGN KEY (plan_id, task_id, owner_id, project_id) REFERENCES execution.plans(id, task_id, owner_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, plan_id, task_id, owner_id) REFERENCES execution.attempts(id, plan_id, task_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id, owner_id) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (model_asset_id, owner_id) REFERENCES media.model_assets(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (blob_id, owner_id) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT,
  CHECK (
    (state='FAILED' AND error IS NOT NULL AND num_nonnulls(asset_id,model_asset_id,blob_id,text_content,structured_content)=0)
    OR (state='SUCCEEDED' AND error IS NULL AND num_nonnulls(asset_id,model_asset_id,blob_id,text_content,structured_content)=1 AND (
      (output_type IN ('IMAGE','VIDEO','AUDIO') AND asset_id IS NOT NULL)
      OR (output_type='MODEL_3D' AND model_asset_id IS NOT NULL)
      OR (output_type='WORLD_3D' AND blob_id IS NOT NULL)
      OR (output_type='TEXT' AND text_content IS NOT NULL)
      OR (output_type IN ('SCRIPT','STORYBOARD') AND structured_content IS NOT NULL)
    ))
  )
);
CREATE INDEX outputs_owner_type_idx ON execution.outputs(owner_id, output_type, created_at DESC, id);
CREATE INDEX outputs_asset_idx ON execution.outputs(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX outputs_model_idx ON execution.outputs(model_asset_id) WHERE model_asset_id IS NOT NULL;

CREATE TABLE execution.events (
  task_id text NOT NULL,
  owner_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, sequence),
  FOREIGN KEY (task_id, owner_id) REFERENCES execution.tasks(id, owner_id) ON DELETE RESTRICT
);

CREATE TABLE execution.history_heads (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  project_id text NOT NULL,
  node_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  result_count bigint NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, node_id),
  UNIQUE (id, owner_id, project_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES public.projects(id, owner_id) ON DELETE RESTRICT
);
CREATE TABLE execution.history_entries (
  id text PRIMARY KEY,
  head_id text NOT NULL,
  owner_id text NOT NULL,
  project_id text NOT NULL,
  output_id text NOT NULL,
  plan_id text NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  visible_node boolean NOT NULL DEFAULT true,
  visible_global boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (head_id, output_id),
  FOREIGN KEY (head_id, owner_id, project_id) REFERENCES execution.history_heads(id, owner_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (output_id, owner_id, project_id, plan_id) REFERENCES execution.outputs(id, owner_id, project_id, plan_id) ON DELETE RESTRICT
);
CREATE INDEX history_node_page_idx ON execution.history_entries(head_id, created_at DESC, id) WHERE visible_node AND deleted_at IS NULL;
CREATE INDEX history_global_page_idx ON execution.history_entries(owner_id, created_at DESC, id) WHERE visible_global AND deleted_at IS NULL;
-- Append/delete visibility + head revision/count + optional current-output fallback
-- are one transaction. Deleting history never deletes outputs or physical files.

-- P3. HyperFrames files/rendering are independent from canvas and IPAC projects.
CREATE TABLE studio.hf_projects (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_id)
);
CREATE INDEX hf_projects_owner_updated_idx ON studio.hf_projects(owner_id, updated_at DESC, id) WHERE deleted_at IS NULL;

CREATE TABLE studio.hf_files (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  owner_id text NOT NULL,
  path text NOT NULL CHECK (platform.valid_relative_path(path)),
  mime_type text NOT NULL,
  content_text text,
  blob_id text,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES studio.hf_projects(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (blob_id, owner_id) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT,
  CHECK (num_nonnulls(content_text,blob_id)=1)
);
CREATE UNIQUE INDEX hf_files_path_uq ON studio.hf_files(project_id, path) WHERE deleted_at IS NULL;
CREATE INDEX hf_files_blob_idx ON studio.hf_files(blob_id) WHERE blob_id IS NOT NULL;

CREATE TABLE studio.hf_revisions (
  project_id text NOT NULL,
  owner_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, revision, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES studio.hf_projects(id, owner_id) ON DELETE RESTRICT
);
CREATE TRIGGER hf_revisions_immutable BEFORE UPDATE OR DELETE ON studio.hf_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

CREATE TABLE studio.hf_revision_files (
  project_id text NOT NULL,
  project_revision bigint NOT NULL,
  owner_id text NOT NULL,
  path text NOT NULL CHECK (platform.valid_relative_path(path)),
  mime_type text NOT NULL,
  content_text text,
  blob_id text,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (project_id, project_revision, path),
  FOREIGN KEY (project_id, project_revision, owner_id) REFERENCES studio.hf_revisions(project_id, revision, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (blob_id, owner_id) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT,
  CHECK (num_nonnulls(content_text,blob_id)=1)
);
CREATE INDEX hf_revision_files_blob_idx ON studio.hf_revision_files(blob_id) WHERE blob_id IS NOT NULL;
CREATE TRIGGER hf_revision_files_immutable BEFORE UPDATE OR DELETE ON studio.hf_revision_files
  FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();

-- HF videos are blobs owned by the renderer user; later import creates a private
-- canvas Asset via real upload/import. Frozen HFRender.outputAssetId remains null
-- until that Asset exists; no HF project ID is ever placed in assets.project_id.
CREATE TABLE studio.hf_renders (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  project_revision bigint NOT NULL,
  owner_id text NOT NULL,
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  progress numeric(7,6) CHECK (progress BETWEEN 0 AND 1),
  output_blob_id text,
  imported_asset_id text,
  lease_owner text,
  lease_until timestamptz,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence>=0),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (id, owner_id),
  FOREIGN KEY (project_id, project_revision, owner_id) REFERENCES studio.hf_revisions(project_id, revision, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (output_blob_id, owner_id) REFERENCES media.blobs(id, owner_key) ON DELETE RESTRICT,
  FOREIGN KEY (imported_asset_id, owner_id) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (state<>'SUCCEEDED' OR output_blob_id IS NOT NULL)
);
CREATE INDEX hf_renders_project_idx ON studio.hf_renders(owner_id, project_id, created_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX hf_renders_dispatch_idx ON studio.hf_renders(created_at, id) WHERE state IN ('QUEUED','RUNNING');

CREATE TABLE studio.director_projects (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('2D','3D')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  content jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content)='object'),
  thumbnail_asset_id text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, owner_id),
  FOREIGN KEY (thumbnail_asset_id, owner_id) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT
);
CREATE INDEX director_projects_owner_kind_idx ON studio.director_projects(owner_id, kind, updated_at DESC, id) WHERE deleted_at IS NULL;
-- nodeStorageMode director schemas continue in projects.graph; no duplicate row.

CREATE TABLE studio.director_models (
  id text PRIMARY KEY,
  owner_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  owner_key text GENERATED ALWAYS AS (coalesce(owner_id,'@catalog')) STORED,
  scope text NOT NULL CHECK (scope IN ('PRIVATE','CURATED')),
  kind text NOT NULL CHECK (kind IN ('PROP','ACTOR','SCENE','ANIMATION')),
  category_id text REFERENCES catalog.categories(id) ON DELETE RESTRICT,
  name_localized jsonb NOT NULL CHECK (jsonb_typeof(name_localized)='object'),
  model_asset_id text,
  catalog_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  preview_media_id text REFERENCES catalog.media(id) ON DELETE RESTRICT,
  preview_asset_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (model_asset_id, owner_key) REFERENCES media.model_assets(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (preview_asset_id, owner_key) REFERENCES public.assets(id, owner_id) ON DELETE RESTRICT,
  CHECK ((scope='PRIVATE' AND owner_id IS NOT NULL) OR (scope='CURATED' AND owner_id IS NULL)),
  CHECK (num_nonnulls(model_asset_id,catalog_media_id)=1),
  CHECK (num_nonnulls(preview_media_id,preview_asset_id)<=1)
);
CREATE INDEX director_models_catalog_idx ON studio.director_models(scope,kind,category_id,id) WHERE deleted_at IS NULL;
CREATE INDEX director_models_owner_idx ON studio.director_models(owner_key,created_at DESC,id) WHERE deleted_at IS NULL;

-- P2 Canvas / P3 HF. One conversation model; no duplicate HF sessions store.
CREATE TABLE assistant.conversations (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  business text NOT NULL CHECK (business IN ('CANVAS','HYPERFRAMES')),
  canvas_project_id text,
  hf_project_id text,
  title text NOT NULL DEFAULT '' CHECK (char_length(title)<=120),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  next_message_sequence bigint NOT NULL DEFAULT 1 CHECK (next_message_sequence>0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id,owner_id),
  FOREIGN KEY (canvas_project_id,owner_id) REFERENCES public.projects(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (hf_project_id,owner_id) REFERENCES studio.hf_projects(id,owner_id) ON DELETE RESTRICT,
  CHECK ((business='CANVAS' AND canvas_project_id IS NOT NULL AND hf_project_id IS NULL)
    OR (business='HYPERFRAMES' AND canvas_project_id IS NULL))
);
CREATE INDEX conversations_canvas_idx ON assistant.conversations(owner_id,canvas_project_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX conversations_hf_idx ON assistant.conversations(owner_id,hf_project_id,updated_at DESC,id) WHERE deleted_at IS NULL;

CREATE TABLE assistant.messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence>0),
  role text NOT NULL CHECK (role IN ('SYSTEM','USER','ASSISTANT','TOOL')),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) IN ('array','object')),
  attachments_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments_snapshot)='array'),
  run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,sequence),
  UNIQUE (id,conversation_id,owner_id),
  FOREIGN KEY (conversation_id,owner_id) REFERENCES assistant.conversations(id,owner_id) ON DELETE RESTRICT
);

CREATE TABLE assistant.runs (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  input_message_id text NOT NULL,
  agent_key text NOT NULL,
  capability_id text NOT NULL,
  capability_version text NOT NULL,
  interaction_mode text NOT NULL DEFAULT 'ASK' CHECK (interaction_mode IN ('ASK','AUTO')),
  skill_versions_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skill_versions_snapshot)='array'),
  provider_response_id text,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','WAITING_TOOL','CANCEL_REQUESTED','SUCCEEDED','FAILED','CANCELED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  lease_owner text,
  lease_until timestamptz,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence>=0),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (id,conversation_id,owner_id),
  FOREIGN KEY (conversation_id,owner_id) REFERENCES assistant.conversations(id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (input_message_id,conversation_id,owner_id) REFERENCES assistant.messages(id,conversation_id,owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (capability_id,capability_version) REFERENCES catalog.model_versions(capability_id,version) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL))
);
CREATE UNIQUE INDEX runs_one_active_uq ON assistant.runs(conversation_id) WHERE state IN ('QUEUED','RUNNING','WAITING_TOOL','CANCEL_REQUESTED');
ALTER TABLE assistant.messages ADD CONSTRAINT messages_run_owner_fk
  FOREIGN KEY (run_id,conversation_id,owner_id) REFERENCES assistant.runs(id,conversation_id,owner_id) ON DELETE RESTRICT;

CREATE TABLE assistant.tool_calls (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  call_id text NOT NULL,
  tool_name text NOT NULL,
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments)='object'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED')),
  requires_confirmation boolean NOT NULL DEFAULT false,
  deadline_at timestamptz,
  result jsonb,
  expected_project_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id,call_id),
  FOREIGN KEY (run_id,conversation_id,owner_id) REFERENCES assistant.runs(id,conversation_id,owner_id) ON DELETE RESTRICT
);
CREATE TABLE assistant.events (
  run_id text NOT NULL,
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence>0),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,sequence),
  FOREIGN KEY (run_id,conversation_id,owner_id) REFERENCES assistant.runs(id,conversation_id,owner_id) ON DELETE RESTRICT
);
-- Message checkpoints/events are batched; do not INSERT every token. Stream
-- Last-Event-ID maps to (run_id, sequence), tool receipts to unique(run_id,call_id).

-- P2. Transactional infrastructure records, not business resource EAV or a
-- universal aggregate repository. A domain mutation and outbox insert commit
-- together; delivery is at least once. Inbox deduplicates authenticated receipts.
CREATE TABLE platform.outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  lease_owner text,
  lease_until timestamptz,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text,
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL))
);
CREATE INDEX outbox_dispatch_idx ON platform.outbox(available_at,id) WHERE processed_at IS NULL;
CREATE TABLE platform.inbox (
  source text NOT NULL,
  event_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED','PROCESSED','REJECTED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  result_code text,
  PRIMARY KEY (source,event_id)
);
CREATE INDEX inbox_pending_idx ON platform.inbox(received_at,source,event_id) WHERE state='RECEIVED';

-- P1 Skill / P3 HF. Non-media document/font/file uploads use a purpose-bound private grant.
-- uploadId is the client-visible receipt; blobId stays internal. New Skill can
-- upload before its draft exists; saving binds only the same user's completed
-- SKILL grant. HF always binds an existing owned HF project before upload.
CREATE TABLE media.blob_uploads (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('SKILL','HF')),
  resource_id text,
  resource_owner_key text,
  resource_kind text,
  hf_project_id text,
  blob_id text NOT NULL,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  grant_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','UPLOADED','READY','REJECTED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  complete_deadline_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  completed_at timestamptz,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,owner_id,blob_id),
  FOREIGN KEY (blob_id,owner_id) REFERENCES media.blobs(id,owner_key) ON DELETE RESTRICT,
  FOREIGN KEY (resource_id,resource_owner_key,resource_kind) REFERENCES catalog.resources(id,owner_key,kind) MATCH FULL ON DELETE RESTRICT,
  FOREIGN KEY (hf_project_id,owner_id) REFERENCES studio.hf_projects(id,owner_id) ON DELETE RESTRICT,
  CHECK (complete_deadline_at>=expires_at),
  CHECK ((purpose='SKILL' AND hf_project_id IS NULL AND
          (resource_id IS NULL OR (resource_owner_key=owner_id AND resource_kind='SKILL')))
    OR (purpose='HF' AND hf_project_id IS NOT NULL AND resource_id IS NULL)),
  CHECK (state<>'READY' OR completed_at IS NOT NULL)
);
CREATE INDEX blob_uploads_owner_purpose_idx ON media.blob_uploads(owner_id,purpose,created_at DESC,id);
CREATE INDEX blob_uploads_expiry_idx ON media.blob_uploads(complete_deadline_at) WHERE state IN ('PENDING','UPLOADED');
ALTER TABLE catalog.skill_files ADD COLUMN upload_id text;
ALTER TABLE catalog.skill_files ADD CONSTRAINT skill_files_upload_owner_fk
  FOREIGN KEY (upload_id,owner_key,blob_id) REFERENCES media.blob_uploads(id,owner_id,blob_id) ON DELETE RESTRICT;
ALTER TABLE studio.hf_files ADD COLUMN upload_id text;
ALTER TABLE studio.hf_files ADD CONSTRAINT hf_files_upload_owner_fk
  FOREIGN KEY (upload_id,owner_id,blob_id) REFERENCES media.blob_uploads(id,owner_id,blob_id) ON DELETE RESTRICT;
-- The application additionally checks READY + purpose + root binding. A valid
-- upload to HF root A does not authorize linking its receipt into HF root B.

-- P3. Durable file-change stream, distinct from private delivery outbox.
-- Identity sequence is global/monotonic (gaps are valid); cursor includes root.
-- A file mutation + new project revision + this event + outbox share one commit.
CREATE TABLE studio.hf_events (
  project_id text NOT NULL,
  owner_id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  project_revision bigint NOT NULL CHECK (project_revision>0),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version>0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,sequence),
  FOREIGN KEY (project_id,owner_id) REFERENCES studio.hf_projects(id,owner_id) ON DELETE RESTRICT
);

-- Apply the same adjacency-tree cycle guarantee to curated taxonomies/groups.
-- A transaction advisory lock serializes each tree's mutations (catalog writes
-- are controlled administration/seed operations, not tv.access-user writes).
CREATE FUNCTION catalog.guard_category_tree() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.namespace<>OLD.namespace OR NEW.node_role<>OLD.node_role) THEN
    RAISE EXCEPTION 'taxonomy namespace and node role are immutable' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(726401,hashtext(NEW.namespace));
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM catalog.categories WHERE id=NEW.parent_id AND namespace=NEW.namespace
      UNION
      SELECT c.id,c.parent_id FROM catalog.categories c JOIN ancestors a ON c.id=a.parent_id WHERE c.namespace=NEW.namespace
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  ) THEN RAISE EXCEPTION 'taxonomy cycle is forbidden' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER categories_tree_guard BEFORE INSERT OR UPDATE ON catalog.categories
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_category_tree();

CREATE FUNCTION catalog.guard_model_group_tree() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(726402,1);
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM catalog.model_groups WHERE id=NEW.parent_id
      UNION
      SELECT g.id,g.parent_id FROM catalog.model_groups g JOIN ancestors a ON g.id=a.parent_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  ) THEN RAISE EXCEPTION 'model group cycle is forbidden' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_groups_tree_guard BEFORE INSERT OR UPDATE ON catalog.model_groups
  FOR EACH ROW EXECUTE FUNCTION catalog.guard_model_group_tree();

-- Ownership/type reassignment is not a business operation. Keeping parent owner
-- columns immutable closes update-based scope changes when a root has no children.
CREATE FUNCTION platform.guard_immutable_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW)->column_name IS DISTINCT FROM to_jsonb(OLD)->column_name THEN
      RAISE EXCEPTION 'column % is immutable',column_name USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blobs_owner_guard BEFORE UPDATE ON media.blobs FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','scope');
CREATE TRIGGER model_assets_owner_guard BEFORE UPDATE ON media.model_assets FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id');
CREATE TRIGGER characters_owner_guard BEFORE UPDATE ON catalog.characters FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','scope');
CREATE TRIGGER resources_owner_guard BEFORE UPDATE ON catalog.resources FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','scope','kind');
CREATE TRIGGER items_owner_guard BEFORE UPDATE ON library.items FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','kind','item_type');
CREATE TRIGGER tasks_snapshot_guard BEFORE UPDATE ON execution.tasks FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','project_id','project_revision','target_type','target_id','executor_kind','task_kind','graph_snapshot','source_app_id','source_app_version','source_app_owner_key','request_hash','execution_key');
CREATE TRIGGER plans_snapshot_guard BEFORE UPDATE ON execution.plans FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('task_id','owner_id','project_id','node_id','capability_id','capability_version','invocation_type','executor_spec','params_snapshot','node_config_snapshot','attachments_snapshot','output_count');
CREATE TRIGGER outputs_immutable BEFORE UPDATE OR DELETE ON execution.outputs FOR EACH ROW EXECUTE FUNCTION platform.reject_version_update();
CREATE TRIGGER hf_projects_owner_guard BEFORE UPDATE ON studio.hf_projects FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id');
CREATE TRIGGER hf_files_owner_guard BEFORE UPDATE ON studio.hf_files FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('project_id','owner_id');
CREATE TRIGGER hf_renders_snapshot_guard BEFORE UPDATE ON studio.hf_renders FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('project_id','owner_id','project_revision','settings');
CREATE TRIGGER director_projects_owner_guard BEFORE UPDATE ON studio.director_projects FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','kind');
CREATE TRIGGER director_models_owner_guard BEFORE UPDATE ON studio.director_models FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','scope','kind');
CREATE TRIGGER conversations_owner_guard BEFORE UPDATE ON assistant.conversations FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','business','canvas_project_id');
CREATE TRIGGER assistant_runs_snapshot_guard BEFORE UPDATE ON assistant.runs FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('conversation_id','owner_id','input_message_id','agent_key','capability_id','capability_version','interaction_mode','skill_versions_snapshot');
CREATE TRIGGER blob_uploads_owner_guard BEFORE UPDATE ON media.blob_uploads FOR EACH ROW EXECUTE FUNCTION platform.guard_immutable_columns('owner_id','purpose','hf_project_id','blob_id','file_name');

-- A verified object locator/identity cannot be swapped under retained references.
-- State/deleted_at can change; physical object metadata stays the verified fact.
CREATE FUNCTION media.guard_verified_blob() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE column_name text;
BEGIN
  IF OLD.state='READY' OR OLD.verified_at IS NOT NULL THEN
    FOREACH column_name IN ARRAY ARRAY['backend','bucket','object_key','object_version','mime_type','byte_size','checksum_sha256','verified_at'] LOOP
      IF to_jsonb(NEW)->column_name IS DISTINCT FROM to_jsonb(OLD)->column_name THEN
        RAISE EXCEPTION 'verified blob column % is immutable',column_name USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blobs_verified_guard BEFORE UPDATE ON media.blobs
  FOR EACH ROW EXECUTE FUNCTION media.guard_verified_blob();

-- HF sessions can exist before AI project confirmation. Bind exactly once; no
-- later reassignment silently changes what a conversation/active run controls.
CREATE FUNCTION assistant.guard_hf_first_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.hf_project_id IS NOT NULL AND NEW.hf_project_id IS DISTINCT FROM OLD.hf_project_id THEN
    RAISE EXCEPTION 'HF conversation project binding is immutable after first binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversations_hf_binding_guard BEFORE UPDATE ON assistant.conversations
  FOR EACH ROW EXECUTE FUNCTION assistant.guard_hf_first_binding();

-- Domain rules deliberately remain explicit outside DDL:
-- - tv.access at every enabled protected endpoint; owner from validated identity.
-- - soft-deleted/READY/media-kind checks and category namespace applicability.
-- - character filters: AND categories / OR options; stable sort before paging.
-- - task transitions, DAG validation, cancellation/terminal race handling.
-- - worker claims atomically increment fence; stale completion requires matching
--   (id, lease_owner, fence), callback inbox and provider receipt IDs are deduped.
-- - no generic root mutation from user-supplied owner/scope/provider keys.
-- - graph refs + library refs + output/HF/Skill blob refs checked before object GC.
-- - folder batch APIs select all roots FOR UPDATE before changes; deleted parent
--   descendants/items must be explicitly handled, never silently disappear.
-- - new folders use MIXED without asking the user to choose media kind. Legacy
--   typed folders still reject mismatched item kind in the library domain.
-- - template/skill/version deletion requires reference audit; published versions
--   are retained, normal DELETE routes soft-delete the root instead.
-- - version child files are inserted only during complete CreateVersion under a
--   root transaction. SQL FK/immutable UPDATE triggers do not prevent INSERT of
--   a new path into an old version; no AppendFile(oldVersion) port is exposed.
-- - frozen core/extension DTOs are projections, not raw SELECT * rows.
-- pg_trgm/search indexes can be added after real data volume/query measurements.
-- No payment, community, workspace/RBAC, Redis, Kafka or graph DB tables added.

COMMIT;

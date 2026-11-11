-- First assistant slice: private Global and Canvas conversation persistence.
-- Requires 001/002/003 in public. No studio/catalog/execution/run tables.
-- No user, RBAC, workspace or native Router session is created here.
CREATE SCHEMA assistant;

-- Necessary referenced owner key; preserve all existing project data.
ALTER TABLE public.projects ADD CONSTRAINT studio_projects_id_owner_uq UNIQUE(id,owner_id);

CREATE TABLE assistant.conversations (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  owner_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  business text NOT NULL CHECK (business IN ('GLOBAL','CANVAS')),
  canvas_project_id text,
  -- HF is explicitly disabled until its real schema and ownership FK exist.
  hf_project_id text CHECK (hf_project_id IS NULL),
  title text NOT NULL DEFAULT '' CHECK (char_length(title)<=120),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  next_message_sequence bigint NOT NULL DEFAULT 1 CHECK (next_message_sequence>0),
  router_key text CHECK (router_key IS NULL OR char_length(router_key)>0),
  router_session_ref text CHECK (router_session_ref IS NULL OR char_length(router_session_ref)>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,owner_id),
  UNIQUE(id,owner_id,canvas_project_id),
  CONSTRAINT conversations_project_owner_fk FOREIGN KEY(canvas_project_id,owner_id)
    REFERENCES public.projects(id,owner_id) ON DELETE RESTRICT,
  CONSTRAINT conversations_kind_binding_check CHECK (
    (business='GLOBAL' AND canvas_project_id IS NULL AND hf_project_id IS NULL) OR
    (business='CANVAS' AND canvas_project_id IS NOT NULL AND hf_project_id IS NULL)
  ),
  CHECK ((router_key IS NULL)=(router_session_ref IS NULL))
);
CREATE INDEX conversations_owner_updated_idx ON assistant.conversations(owner_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX conversations_canvas_idx ON assistant.conversations(owner_id,canvas_project_id,updated_at DESC,id) WHERE deleted_at IS NULL;
-- Keep this uniqueness after soft deletion too: a Router logical session must
-- never be reused by a second product root/owner.
CREATE UNIQUE INDEX conversations_router_session_uq ON assistant.conversations(router_key,router_session_ref) WHERE router_key IS NOT NULL AND router_session_ref IS NOT NULL;

-- Shape rules match current MessagePart, not the broader old SQL blueprint.
-- Fixed STRUCTURED schema and READY media checks belong to future write cases.
CREATE FUNCTION assistant.valid_message_parts(parts jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE part jsonb; kind text; keys integer;
BEGIN
  IF jsonb_typeof(parts)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(parts)>100 THEN RETURN false; END IF;
  FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
    IF jsonb_typeof(part)<>'object' THEN RETURN false; END IF;
    SELECT count(*) INTO keys FROM jsonb_object_keys(part);
    IF jsonb_typeof(part->'type') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    kind := part->>'type';
    IF kind='TEXT' THEN
      IF keys<>2 OR jsonb_typeof(part->'text') IS DISTINCT FROM 'string' OR char_length(part->>'text')>200000 THEN RETURN false; END IF;
    ELSIF kind='ASSET' THEN
      IF keys<>2 OR jsonb_typeof(part->'assetId') IS DISTINCT FROM 'string' OR char_length(part->>'assetId') NOT BETWEEN 1 AND 200 THEN RETURN false; END IF;
    ELSIF kind='STRUCTURED' THEN
      IF keys<>3 OR jsonb_typeof(part->'schemaCode') IS DISTINCT FROM 'string' OR char_length(part->>'schemaCode')>100 OR jsonb_typeof(part->'value') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    ELSE RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE assistant.messages (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  conversation_id text NOT NULL,
  owner_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence>0),
  role text NOT NULL CHECK (role IN ('USER','ASSISTANT','TOOL')),
  content jsonb NOT NULL CHECK (assistant.valid_message_parts(content)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,sequence),
  UNIQUE(id,conversation_id,owner_id),
  CONSTRAINT messages_conversation_owner_fk FOREIGN KEY(conversation_id,owner_id)
    REFERENCES assistant.conversations(id,owner_id) ON DELETE RESTRICT
);
CREATE INDEX messages_owner_conversation_sequence_idx ON assistant.messages(owner_id,conversation_id,sequence,id);
-- run_id/attachments/task binding and their FKs are added with actual execution
-- and media use cases, never represented here by unverified JSON or fake IDs.

CREATE FUNCTION assistant.guard_conversation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.business IS DISTINCT FROM OLD.business OR NEW.canvas_project_id IS DISTINCT FROM OLD.canvas_project_id
     OR NEW.hf_project_id IS DISTINCT FROM OLD.hf_project_id THEN
    RAISE EXCEPTION 'conversation ownership and binding are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.revision<OLD.revision OR NEW.next_message_sequence<OLD.next_message_sequence
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'conversation revision, sequence or deletion cannot regress' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversations_identity_guard BEFORE UPDATE ON assistant.conversations
FOR EACH ROW EXECUTE FUNCTION assistant.guard_conversation_identity();
-- Future appends lock the conversation root, allocate next_message_sequence,
-- advance revision and insert message in one UoW. No public write is enabled.

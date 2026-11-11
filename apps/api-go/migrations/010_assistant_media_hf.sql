ALTER TABLE assistant.conversations DROP CONSTRAINT conversations_business_check;
ALTER TABLE assistant.conversations ADD CONSTRAINT conversations_business_check CHECK(business IN ('GLOBAL','CANVAS','HF'));
ALTER TABLE assistant.conversations DROP CONSTRAINT conversations_hf_project_id_check;
ALTER TABLE assistant.conversations DROP CONSTRAINT conversations_kind_binding_check;
ALTER TABLE assistant.conversations ADD CONSTRAINT conversations_kind_binding_check CHECK(
 (business='GLOBAL' AND canvas_project_id IS NULL AND hf_project_id IS NULL) OR
 (business='CANVAS' AND canvas_project_id IS NOT NULL AND hf_project_id IS NULL) OR
 (business='HF' AND canvas_project_id IS NULL));
ALTER TABLE assistant.conversations ADD CONSTRAINT conversations_hf_owner_fk FOREIGN KEY(hf_project_id,owner_id) REFERENCES resources.studio_projects(id,owner_id);
CREATE TABLE assistant.message_assets (
 message_id text NOT NULL,
 conversation_id text NOT NULL,
 owner_id text NOT NULL,
 asset_id text NOT NULL,
 PRIMARY KEY(message_id,asset_id),
 FOREIGN KEY(message_id,conversation_id,owner_id) REFERENCES assistant.messages(id,conversation_id,owner_id),
 FOREIGN KEY(asset_id,owner_id) REFERENCES public.assets(id,owner_id)
);
CREATE TABLE assistant.hf_agents (
 id text PRIMARY KEY,
 conversation_id text NOT NULL,
 owner_id text NOT NULL,
 profile_code text NOT NULL DEFAULT 'STUDIO_HF_ASSISTANT',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,owner_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES assistant.conversations(id,owner_id)
);
CREATE TABLE assistant.hf_commands (
 owner_id text NOT NULL,
 conversation_id text NOT NULL,
 idempotency_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 expected_revision bigint NOT NULL CHECK(expected_revision>0),
 capability_ref text NOT NULL,
 capability_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,conversation_id,idempotency_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES assistant.conversations(id,owner_id)
);
CREATE OR REPLACE FUNCTION assistant.guard_conversation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
 OR NEW.business IS DISTINCT FROM OLD.business OR NEW.canvas_project_id IS DISTINCT FROM OLD.canvas_project_id THEN
 RAISE EXCEPTION 'conversation ownership and kind are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.hf_project_id IS DISTINCT FROM OLD.hf_project_id AND NOT (
 OLD.business='HF' AND OLD.deleted_at IS NULL AND OLD.hf_project_id IS NULL AND NEW.hf_project_id IS NOT NULL
 AND NEW.revision>OLD.revision AND EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=NEW.hf_project_id AND h.owner_id=OLD.owner_id AND h.deleted_at IS NULL
 AND(h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects p WHERE p.id=h.project_id AND p.owner_id=h.owner_id AND p.deleted_at IS NULL)))) THEN
 RAISE EXCEPTION 'established HF binding is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.revision<OLD.revision OR NEW.next_message_sequence<OLD.next_message_sequence
 OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
 RAISE EXCEPTION 'conversation revision, sequence or deletion cannot regress' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;

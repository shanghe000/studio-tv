CREATE SCHEMA execution;
ALTER TABLE public.projects ADD COLUMN internal_kind text CHECK(internal_kind IN ('ASSET_VAULT','STUDIO_ASSETS'));
-- FILE is exposed through the product extension; frozen v1 upload formats stay unchanged.
ALTER TABLE public.assets DROP CONSTRAINT assets_kind_check;
ALTER TABLE public.assets ADD CONSTRAINT assets_kind_check CHECK(kind IN ('IMAGE','VIDEO','AUDIO','FILE'));
CREATE TABLE execution.tasks (
 id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES public.users(id),
 project_id text,
 conversation_id text,
 kind text NOT NULL CHECK(kind IN ('CANVAS','ASSISTANT','MEDIA','SKETCH','STUDIO')),
 state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 idempotency_key uuid NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 lease_token uuid,
 lease_until timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),
 history_deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,kind,idempotency_key),
 UNIQUE(id,owner_id),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES assistant.conversations(id,owner_id),
 CHECK((kind='ASSISTANT')=(conversation_id IS NOT NULL)),
 CHECK(kind='ASSISTANT' OR project_id IS NOT NULL)
);
CREATE UNIQUE INDEX tasks_active_conversation ON execution.tasks(conversation_id) WHERE conversation_id IS NOT NULL AND state IN ('QUEUED','RUNNING');
CREATE INDEX tasks_queue ON execution.tasks(available_at,created_at,id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX tasks_owner_history ON execution.tasks(owner_id,project_id,created_at DESC,id) WHERE history_deleted_at IS NULL;
CREATE TABLE execution.task_assets (
 task_id text NOT NULL,
 owner_id text NOT NULL,
 asset_id text NOT NULL REFERENCES public.assets(id),
 direction text NOT NULL CHECK(direction IN ('INPUT','OUTPUT')),
 PRIMARY KEY(task_id,asset_id,direction),
 FOREIGN KEY(task_id,owner_id) REFERENCES execution.tasks(id,owner_id)
);
CREATE TABLE execution.read_grants (
 id text PRIMARY KEY,
 task_id text NOT NULL,
 owner_id text NOT NULL,
 asset_id text NOT NULL REFERENCES public.assets(id),
 source_version text NOT NULL,
 checksum_sha256 text NOT NULL CHECK(length(checksum_sha256)=64),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(task_id,owner_id) REFERENCES execution.tasks(id,owner_id)
);
CREATE TABLE execution.events (
 task_id text NOT NULL,
 owner_id text NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),
 type text NOT NULL,
 data jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 test_mode boolean NOT NULL DEFAULT false,
 PRIMARY KEY(task_id,sequence),
 FOREIGN KEY(task_id,owner_id) REFERENCES execution.tasks(id,owner_id)
);
CREATE TABLE execution.assistant_results (
 task_id text PRIMARY KEY REFERENCES execution.tasks(id),
 message_id text NOT NULL UNIQUE REFERENCES assistant.messages(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE execution.history_sequence;
CREATE TABLE execution.history_revisions (
 owner_id text NOT NULL,
 project_id text NOT NULL,
 node_id text NOT NULL,
 revision bigint NOT NULL DEFAULT nextval('execution.history_sequence'),
 PRIMARY KEY(owner_id,project_id,node_id),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id)
);

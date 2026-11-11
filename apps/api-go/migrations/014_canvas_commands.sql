-- First server-validated canvas command slice. This does not enable agent runs
-- or a realtime event stream, and does not change the legacy graph writer.
CREATE SCHEMA canvas;
ALTER TABLE public.projects ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0 CHECK(event_sequence>=0);

CREATE TABLE canvas.project_events (
 project_id text NOT NULL,
 owner_id text NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),
 type text NOT NULL CHECK(type IN ('canvas.changed','canvas.invalidated','node.execution.changed','node.result.applied','node.result.not-applied')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(project_id,sequence),
 UNIQUE(project_id,owner_id,sequence),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id) ON DELETE RESTRICT
);
CREATE INDEX canvas_project_events_owner ON canvas.project_events(owner_id,project_id,sequence);

CREATE TABLE canvas.command_receipts (
 command_id text PRIMARY KEY CHECK(char_length(command_id) BETWEEN 1 AND 64),
 owner_id text NOT NULL,
 project_id text NOT NULL,
 operation text NOT NULL CHECK(operation='submitCanvasCommand'),
 key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 base_revision bigint NOT NULL CHECK(base_revision>0),
 graph_revision bigint NOT NULL CHECK(graph_revision=base_revision+1),
 event_sequence bigint NOT NULL CHECK(event_sequence>0),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 committed_at timestamptz NOT NULL,
 UNIQUE(owner_id,project_id,operation,key),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,owner_id,event_sequence) REFERENCES canvas.project_events(project_id,owner_id,sequence) ON DELETE RESTRICT
);

-- Receipts and event evidence are append-only. Project ownership/deletion
-- remain the authority on every retrieval and exact idempotency replay.
CREATE FUNCTION canvas.guard_command_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'canvas command receipts and events are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER command_receipts_immutable BEFORE UPDATE OR DELETE ON canvas.command_receipts FOR EACH ROW EXECUTE FUNCTION canvas.guard_command_evidence();
CREATE TRIGGER project_events_immutable BEFORE UPDATE OR DELETE ON canvas.project_events FOR EACH ROW EXECUTE FUNCTION canvas.guard_command_evidence();

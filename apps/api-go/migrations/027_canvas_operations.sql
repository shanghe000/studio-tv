-- Browser edits mutate the one canonical projects.graph under its row lock.
-- Receipts survive reconnect/restart and are scoped to the verified actor/page.
CREATE TABLE canvas.operation_receipts (
 project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 64),
 batch_id text NOT NULL CHECK(length(batch_id) BETWEEN 1 AND 64),
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 receipt jsonb NOT NULL,
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,actor_id,batch_id)
);

CREATE TABLE collaboration.canvas_edit_sessions (
 project_id text PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 session_id text NOT NULL,
 client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 64),
 expires_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Switch per project under its existing row lock, allowing deployed single-page
-- clients to finish. Independent page terms fence delayed writes after rejoin.
ALTER TABLE collaboration.canvas_writer_protocol ADD COLUMN account_pages boolean NOT NULL DEFAULT false;
CREATE TABLE collaboration.canvas_account_writers(
 project_id text PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 term_id uuid NOT NULL DEFAULT gen_random_uuid(),
 handoff_id uuid,
 handoff_until timestamptz,
 CHECK ((handoff_id IS NULL)=(handoff_until IS NULL))
);
CREATE TABLE collaboration.canvas_account_pages(
 project_id text NOT NULL REFERENCES collaboration.canvas_account_writers(project_id) ON DELETE CASCADE,
 session_id text NOT NULL, client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 64),
 page_hash bytea NOT NULL CHECK(octet_length(page_hash)=32),
 lease_id uuid NOT NULL DEFAULT gen_random_uuid(), needs_sync boolean NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(project_id,session_id,client_id)
);

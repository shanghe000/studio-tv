-- A tenure survives renewals but changes on every acquire, transfer or resume.
-- Raw reload credentials only exist in the successful recipient response.
ALTER TABLE collaboration.canvas_edit_sessions
 ADD COLUMN lease_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN resume_hash bytea CHECK (resume_hash IS NULL OR octet_length(resume_hash)=32),
 ADD COLUMN needs_sync boolean NOT NULL DEFAULT false,
 ADD COLUMN page_hash bytea CHECK(page_hash IS NULL OR octet_length(page_hash)=32),
 ADD COLUMN resume_salt bytea CHECK(resume_salt IS NULL OR octet_length(resume_salt)=32);

CREATE TABLE collaboration.canvas_edit_requests (
 project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 from_lease uuid NOT NULL,
 to_lease uuid,
 grant_stamp text NOT NULL,
 page_hash bytea NOT NULL CHECK(octet_length(page_hash)=32),
 from_actor text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 from_session text NOT NULL,
 from_client text NOT NULL,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 session_id text NOT NULL,
 client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 64),
 state text NOT NULL CHECK (state IN ('PENDING','DECLINED','CANCELED','TRANSFERRED','EXPIRED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (project_id,request_id)
);
CREATE INDEX edit_requests_inbox ON collaboration.canvas_edit_requests(project_id,from_lease,expires_at) WHERE state='PENDING';
CREATE INDEX edit_requests_outbox ON collaboration.canvas_edit_requests(project_id,actor_id,session_id,client_id,created_at DESC);
-- Old clients POST both acquire and renew with only a client ID. Retire the old
-- page on replacement so a delayed renewal cannot reclaim a subsequently free
-- lease. An explicit, newly approved application may reactivate that same page.
CREATE TABLE collaboration.canvas_retired_pages (
 project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 session_id text NOT NULL, client_id text NOT NULL,
 retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,actor_id,session_id,client_id)
);

-- A waiting request must not regain authority after a role was revoked and
-- later granted again. Membership mutations advance the existing project
-- grant revision or one of its team revisions.
CREATE FUNCTION collaboration.canvas_handoff_grants(pid text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT md5(concat_ws('/',p.collaboration_revision::text,
   (SELECT string_agg(t.id || ':' || t.revision::text, ',' ORDER BY t.id)
    FROM collaboration.project_teams g JOIN collaboration.teams t ON t.id=g.team_id AND t.deleted_at IS NULL
    WHERE g.project_id=p.id)))
 FROM public.projects p WHERE p.id=pid
$$;

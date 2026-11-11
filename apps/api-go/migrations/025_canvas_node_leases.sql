-- Short-lived collaboration ownership is separate from the persisted graph.
CREATE TABLE collaboration.canvas_node_leases (
    project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    node_id text NOT NULL,
    actor_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    client_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(project_id,node_id),
    CHECK(length(node_id) BETWEEN 1 AND 200),
    CHECK(length(client_id) BETWEEN 1 AND 64)
);
CREATE INDEX canvas_node_leases_expiry ON collaboration.canvas_node_leases(expires_at);
CREATE INDEX canvas_node_leases_client ON collaboration.canvas_node_leases(project_id,actor_id,session_id,client_id);

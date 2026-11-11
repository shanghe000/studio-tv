-- A released/expired lease must not make an upgraded project appear eligible
-- to a background pre-handoff client that repeatedly POSTs "acquire".
CREATE TABLE collaboration.canvas_writer_protocol (
 project_id text PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE
);
INSERT INTO collaboration.canvas_writer_protocol(project_id)
 SELECT project_id FROM collaboration.canvas_edit_sessions WHERE page_hash IS NOT NULL
 UNION SELECT project_id FROM collaboration.canvas_edit_requests;

-- A client that observed a prior incarnation must never update, delete or
-- reconnect the replacement, even when undo deliberately reuses the same ID.
ALTER TABLE canvas.node_versions ADD COLUMN last_deleted_revision bigint NOT NULL DEFAULT 0;
UPDATE canvas.node_versions SET last_deleted_revision=last_changed_project_revision WHERE NOT present;
CREATE FUNCTION canvas.note_node_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.present AND NOT NEW.present THEN NEW.last_deleted_revision:=NEW.last_changed_project_revision; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER note_node_removal BEFORE UPDATE OF present ON canvas.node_versions
 FOR EACH ROW EXECUTE FUNCTION canvas.note_node_removal();

CREATE TABLE canvas.removed_edges(
 project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
 edge_id text NOT NULL, last_deleted_revision bigint NOT NULL,
 PRIMARY KEY(project_id,edge_id)
);
CREATE FUNCTION canvas.note_edge_removals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO canvas.removed_edges(project_id,edge_id,last_deleted_revision)
 SELECT NEW.id,x.id,NEW.revision FROM
 (SELECT value->>'id' AS id FROM jsonb_array_elements(OLD.graph->'edges')
  EXCEPT SELECT value->>'id' FROM jsonb_array_elements(NEW.graph->'edges')) x
 WHERE x.id IS NOT NULL
 ON CONFLICT(project_id,edge_id) DO UPDATE SET last_deleted_revision=excluded.last_deleted_revision;
 RETURN NULL;
END $$;
CREATE TRIGGER note_edge_removals AFTER UPDATE OF graph ON public.projects
 FOR EACH ROW WHEN (OLD.graph->'edges' IS DISTINCT FROM NEW.graph->'edges') EXECUTE FUNCTION canvas.note_edge_removals();

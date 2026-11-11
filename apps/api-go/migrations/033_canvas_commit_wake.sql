-- Content, ACLs and replay cursors remain in the durable event log.
CREATE FUNCTION canvas.notify_project_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('studiotv_canvas_commit', NEW.project_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER canvas_committed_notify AFTER INSERT ON canvas.project_events
FOR EACH ROW EXECUTE FUNCTION canvas.notify_project_commit();

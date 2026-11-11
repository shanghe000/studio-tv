-- A graph/revision writer cannot advance the live cursor without immutable
-- evidence. Legacy writes use invalidation; typed commands supply their own
-- normalized event in the same transaction. No retention policy is introduced.
CREATE FUNCTION canvas.capture_project_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean; reason text;
BEGIN
 IF OLD.internal_kind IS NOT NULL AND NEW.internal_kind IS NOT NULL THEN
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
  RAISE EXCEPTION 'project event identity immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.revision<OLD.revision THEN
  RAISE EXCEPTION 'project revision cannot go backwards' USING ERRCODE='23514';
 END IF;
 -- Even a legacy writer that forgets revision cannot defeat snapshot CAS.
 IF NEW.graph IS DISTINCT FROM OLD.graph AND NEW.revision=OLD.revision THEN
  NEW.revision:=OLD.revision+1;
 END IF;
 changed:=NEW.graph IS DISTINCT FROM OLD.graph OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.internal_kind IS DISTINCT FROM OLD.internal_kind;
 IF NEW.event_sequence IS DISTINCT FROM OLD.event_sequence AND NEW.event_sequence<>OLD.event_sequence+1 THEN
  RAISE EXCEPTION 'project event cursor must advance exactly once' USING ERRCODE='23514';
 END IF;
 IF changed AND NEW.event_sequence=OLD.event_sequence THEN
  NEW.event_sequence:=OLD.event_sequence+1;
  reason:=CASE WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN 'PROJECT_DELETED'
   WHEN NEW.graph IS DISTINCT FROM OLD.graph THEN 'LEGACY_GRAPH_WRITE'
   WHEN NEW.internal_kind IS DISTINCT FROM OLD.internal_kind THEN 'UNREPRESENTABLE_CHANGE'
   ELSE 'REVISION_ONLY' END;
  INSERT INTO canvas.project_events(project_id,owner_id,sequence,type,payload,occurred_at)
  VALUES(NEW.id,NEW.owner_id,NEW.event_sequence,'canvas.invalidated',jsonb_build_object(
   'schemaVersion','1','projectId',NEW.id,'sequence',NEW.event_sequence::text,'occurredAt',now(),
   'source',jsonb_build_object('kind','API'),'type','canvas.invalidated',
   'data',jsonb_build_object('baseRevision',OLD.revision,'graphRevision',NEW.revision,'reason',reason)),now());
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canvas_project_change BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION canvas.capture_project_change();

-- Deferred because commands update projects before inserting their evidence.
-- Every intermediate cursor advance is checked, including multiple writes in
-- one transaction. Other writers may not reserve or silently skip a sequence.
CREATE FUNCTION canvas.require_project_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_sequence IS DISTINCT FROM OLD.event_sequence AND NOT EXISTS(
  SELECT 1 FROM canvas.project_events e WHERE e.project_id=NEW.id AND e.owner_id=NEW.owner_id AND e.sequence=NEW.event_sequence
   AND e.payload->>'schemaVersion'='1' AND e.payload->>'projectId'=NEW.id
   AND e.payload->>'sequence'=NEW.event_sequence::text AND e.payload->>'type'=e.type
   AND jsonb_typeof(e.payload->'data')='object' AND jsonb_typeof(e.payload->'source')='object'
   AND (e.payload->>'occurredAt')::timestamptz=e.occurred_at
 ) THEN
  RAISE EXCEPTION 'project cursor requires matching event evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER canvas_project_event_required AFTER UPDATE ON public.projects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION canvas.require_project_event();

-- Existing evidence is immutable. Oversized historical canvas.changed events
-- are projected as invalidations by replay; newly inserted events are bounded.
ALTER TABLE canvas.project_events ADD CONSTRAINT project_event_payload_bound CHECK(octet_length(payload::text)<=1048576) NOT VALID;

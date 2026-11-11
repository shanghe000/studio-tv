-- A saved input receipt can survive unrelated project changes, but never a
-- change-and-undo or deletion/recreation of any node in its input closure.
-- Existing nodes start conservatively at the current project revision: receipts
-- produced before this migration must refresh once rather than infer history.
ALTER TABLE canvas.node_versions ADD COLUMN last_changed_project_revision bigint;
UPDATE canvas.node_versions v SET last_changed_project_revision=p.revision
 FROM public.projects p WHERE p.id=v.project_id AND p.owner_id=v.owner_id;
ALTER TABLE canvas.node_versions ALTER COLUMN last_changed_project_revision SET NOT NULL;
ALTER TABLE canvas.node_versions ADD CONSTRAINT node_change_revision_positive CHECK(last_changed_project_revision>0);
-- CanvasGuard includes the ordered input closure. Preserve a conservative
-- project-wide boundary for reordering existing nodes, including reorder/undo.
-- Pure node creation/deletion does not change the relative order of survivors.
ALTER TABLE public.projects ADD COLUMN last_node_order_changed_revision bigint NOT NULL DEFAULT 1
 CHECK(last_node_order_changed_revision>0);
UPDATE public.projects SET last_node_order_changed_revision=revision;

CREATE OR REPLACE FUNCTION canvas.track_node_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb; current_node_id text; changed boolean; data jsonb; node_records jsonb;
 old_semantics jsonb; new_semantics jsonb; prior_record jsonb; binding jsonb;
 nodes jsonb[]:=ARRAY[]::jsonb[]; executor text:=current_setting('rhtv.canvas_executor',true);
 change_revision bigint; old_order text[]; new_order text[];
BEGIN
 -- capture_project_change runs after this trigger and repairs a graph writer
 -- that forgot to advance revision. Match that exact eventual revision here.
 change_revision:=CASE WHEN NEW.graph IS DISTINCT FROM OLD.graph AND NEW.revision=OLD.revision
  THEN OLD.revision+1 ELSE NEW.revision END;
 IF NEW.internal_kind IS NOT NULL THEN
  IF OLD.internal_kind IS NULL THEN
   UPDATE canvas.node_versions SET present=false,version=version+1,last_changed_project_revision=change_revision
    WHERE project_id=NEW.id AND present;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.graph IS NOT DISTINCT FROM OLD.graph AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
  AND NEW.internal_kind IS NOT DISTINCT FROM OLD.internal_kind THEN RETURN NEW; END IF;
 IF NEW.deleted_at IS NOT NULL THEN
  UPDATE canvas.node_versions SET present=false,version=version+1,last_changed_project_revision=change_revision
   WHERE project_id=NEW.id AND present;
  RETURN NEW;
 END IF;
 old_semantics:=canvas.node_semantics_index(OLD.graph);
 new_semantics:=canvas.node_semantics_index(NEW.graph);
 SELECT ARRAY(SELECT entry.value->>'id' FROM jsonb_array_elements(OLD.graph->'nodes') AS entry(value)
  WHERE new_semantics ? (entry.value->>'id')) INTO old_order;
 SELECT ARRAY(SELECT entry.value->>'id' FROM jsonb_array_elements(NEW.graph->'nodes') AS entry(value)
  WHERE old_semantics ? (entry.value->>'id')) INTO new_order;
 IF old_order IS DISTINCT FROM new_order THEN
  NEW.last_node_order_changed_revision:=change_revision;
 END IF;
 SELECT COALESCE(jsonb_object_agg(v.node_id,jsonb_build_object(
  'version',v.version,'present',v.present,'binding',to_jsonb(b))),'{}'::jsonb)
 INTO node_records FROM canvas.node_versions v LEFT JOIN canvas.node_execution_bindings b
  ON b.project_id=v.project_id AND b.owner_id=v.owner_id AND b.node_id=v.node_id
 WHERE v.project_id=NEW.id AND v.owner_id=NEW.owner_id;
 UPDATE canvas.node_versions marker SET present=false,version=marker.version+1,last_changed_project_revision=change_revision
 WHERE marker.project_id=NEW.id AND marker.present AND NOT (new_semantics ? marker.node_id);
 INSERT INTO canvas.node_versions AS marker(project_id,owner_id,node_id,present,last_changed_project_revision)
 SELECT NEW.id,NEW.owner_id,key,true,change_revision FROM jsonb_each(new_semantics)
 ON CONFLICT(project_id,node_id) DO UPDATE SET present=true,
  version=marker.version+CASE WHEN NOT marker.present
   OR new_semantics->marker.node_id IS DISTINCT FROM old_semantics->marker.node_id THEN 1 ELSE 0 END,
  last_changed_project_revision=CASE WHEN NOT marker.present
   OR new_semantics->marker.node_id IS DISTINCT FROM old_semantics->marker.node_id
   THEN change_revision ELSE marker.last_changed_project_revision END;
 FOR n IN SELECT value FROM jsonb_array_elements(NEW.graph->'nodes') LOOP
  current_node_id:=n->>'id';
  prior_record:=node_records->current_node_id; binding:=prior_record->'binding';
  IF binding IS NOT NULL AND binding<>'null'::jsonb
   AND executor IS DISTINCT FROM binding->>'task_id' THEN
   data:=COALESCE(n->'data','{}'::jsonb);
   changed:=new_semantics->current_node_id IS DISTINCT FROM old_semantics->current_node_id;
   IF prior_record->>'present'='true' AND prior_record->'version'=binding->'node_version'
    AND binding->>'application_state'<>'DETACHED' THEN
    IF changed THEN
     data:=(data-'taskId')||jsonb_build_object('status','idle');
    ELSE
     data:=data||jsonb_build_object('taskId',binding->>'task_id','status',CASE binding->>'state'
      WHEN 'SUCCEEDED' THEN 'finished' WHEN 'FAILED' THEN 'failed' WHEN 'CANCELED' THEN 'idle' ELSE 'processing' END);
    END IF;
    n:=jsonb_set(n,'{data}',data);
   ELSIF data->>'status'='processing' AND data->>'taskId'=binding->>'task_id' THEN
    n:=jsonb_set(n,'{data}',(data-'taskId')||jsonb_build_object('status','idle'));
   END IF;
  END IF;
  nodes:=array_append(nodes,n);
 END LOOP;
 NEW.graph:=jsonb_set(NEW.graph,'{nodes}',to_jsonb(nodes));
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION canvas.seed_node_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.internal_kind IS NULL AND NEW.deleted_at IS NULL THEN
 INSERT INTO canvas.node_versions(project_id,owner_id,node_id,present,last_changed_project_revision)
 SELECT NEW.id,NEW.owner_id,n->>'id',true,NEW.revision
  FROM jsonb_array_elements(NEW.graph->'nodes') n WHERE n->>'id'<>'rhtv_meta_v1';
 END IF; RETURN NEW;
END $$;

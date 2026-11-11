-- Private lifecycle markers are never supplied by the browser. A node that
-- disappears and returns under the same ID cannot inherit an earlier run.
CREATE TABLE canvas.node_versions (
 project_id text NOT NULL, owner_id text NOT NULL, node_id text NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), present boolean NOT NULL,
 PRIMARY KEY(project_id,node_id), UNIQUE(project_id,owner_id,node_id),
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id)
);
CREATE TABLE canvas.node_execution_bindings (
 project_id text NOT NULL, owner_id text NOT NULL, node_id text NOT NULL,
 task_id text NOT NULL, execution_id text NOT NULL,
 node_version bigint NOT NULL CHECK(node_version>0), input_versions jsonb NOT NULL CHECK(jsonb_typeof(input_versions)='object'),
 input_guard text NOT NULL CHECK(input_guard ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED')),
 application_state text NOT NULL CHECK(application_state IN ('PENDING','APPLIED','DETACHED')),
 reason text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,node_id),
 FOREIGN KEY(project_id,owner_id,node_id) REFERENCES canvas.node_versions(project_id,owner_id,node_id),
 FOREIGN KEY(task_id,owner_id) REFERENCES execution.tasks(id,owner_id)
);
CREATE INDEX canvas_node_binding_task ON canvas.node_execution_bindings(task_id,execution_id);

-- Unknown data is significant. Only known presentation/running indicators
-- are ignored; output, edited text, history selection and model inputs remain.
-- Scan edges once per graph. The trigger reads this index twice (OLD/NEW),
-- rather than scanning the full edge array separately for every node.
CREATE FUNCTION canvas.node_semantics_index(g jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 WITH meta AS MATERIALIZED (
  SELECT COALESCE((SELECT n->'data'->'edges' FROM jsonb_array_elements(g->'nodes') n
   WHERE n->>'id'='rhtv_meta_v1' LIMIT 1),'{}'::jsonb) AS extras
 ), incoming AS MATERIALIZED (
  SELECT e->>'target' AS node_id,jsonb_agg(jsonb_build_object(
   'source',e->>'source','target',e->>'target',
   'sourceHandle',COALESCE(e->>'sourceHandle',''),'targetHandle',COALESCE(e->>'targetHandle',''),
   'conditioningRole',COALESCE(NULLIF(e->>'conditioningRole',''),meta.extras->(e->>'id')->>'conditioningRole','')) ORDER BY ord) AS edges
  FROM jsonb_array_elements(g->'edges') WITH ORDINALITY element(e,ord) CROSS JOIN meta
  GROUP BY e->>'target'
 )
 SELECT COALESCE(jsonb_object_agg(n->>'id',jsonb_build_object(
  'type',n->'type','data',COALESCE(n->'data','{}'::jsonb)-ARRAY[
   '__rhtv','title','label','modelName','modelNameEn','status','taskId','errorMsg','testMode','customBadgeText','progress','width','height','opResize'],
  'incoming',COALESCE(incoming.edges,'[]'::jsonb))),'{}'::jsonb)
 FROM jsonb_array_elements(g->'nodes') n LEFT JOIN incoming ON incoming.node_id=n->>'id'
 WHERE n->>'id'<>'rhtv_meta_v1'
$$;
CREATE FUNCTION canvas.node_semantics(g jsonb,n jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT canvas.node_semantics_index(g)->(n->>'id')
$$;
INSERT INTO canvas.node_versions(project_id,owner_id,node_id,present)
 SELECT p.id,p.owner_id,n->>'id',true FROM public.projects p CROSS JOIN LATERAL jsonb_array_elements(p.graph->'nodes') n
 WHERE p.internal_kind IS NULL AND p.deleted_at IS NULL AND n->>'id'<>'rhtv_meta_v1';

CREATE FUNCTION canvas.track_node_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n jsonb; current_node_id text; changed boolean; data jsonb; node_records jsonb;
 old_semantics jsonb; new_semantics jsonb; prior_record jsonb; binding jsonb;
 nodes jsonb[]:=ARRAY[]::jsonb[]; executor text:=current_setting('rhtv.canvas_executor',true);
BEGIN
 IF NEW.internal_kind IS NOT NULL THEN
  IF OLD.internal_kind IS NULL THEN
   UPDATE canvas.node_versions SET present=false,version=version+1 WHERE project_id=NEW.id AND present;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.graph IS NOT DISTINCT FROM OLD.graph AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
  AND NEW.internal_kind IS NOT DISTINCT FROM OLD.internal_kind THEN RETURN NEW; END IF;
 IF NEW.deleted_at IS NOT NULL THEN
  UPDATE canvas.node_versions SET present=false,version=version+1 WHERE project_id=NEW.id AND present;
  RETURN NEW;
 END IF;
 old_semantics:=canvas.node_semantics_index(OLD.graph);
 new_semantics:=canvas.node_semantics_index(NEW.graph);
 -- Snapshot the pre-write versions and bindings before deletion/upsert. This
 -- identifies authority at OLD, even when this write increments its version.
 SELECT COALESCE(jsonb_object_agg(v.node_id,jsonb_build_object(
  'version',v.version,'present',v.present,'binding',to_jsonb(b))),'{}'::jsonb)
 INTO node_records FROM canvas.node_versions v LEFT JOIN canvas.node_execution_bindings b
  ON b.project_id=v.project_id AND b.owner_id=v.owner_id AND b.node_id=v.node_id
 WHERE v.project_id=NEW.id AND v.owner_id=NEW.owner_id;
 UPDATE canvas.node_versions marker SET present=false,version=marker.version+1
 WHERE marker.project_id=NEW.id AND marker.present AND NOT (new_semantics ? marker.node_id);
 INSERT INTO canvas.node_versions AS marker(project_id,owner_id,node_id,present)
 SELECT NEW.id,NEW.owner_id,key,true FROM jsonb_each(new_semantics)
 ON CONFLICT(project_id,node_id) DO UPDATE SET present=true,
  version=marker.version+CASE WHEN NOT marker.present
   OR new_semantics->marker.node_id IS DISTINCT FROM old_semantics->marker.node_id THEN 1 ELSE 0 END;
 FOR n IN SELECT value FROM jsonb_array_elements(NEW.graph->'nodes') LOOP
  current_node_id:=n->>'id';
  prior_record:=node_records->current_node_id; binding:=prior_record->'binding';
  -- Only the internal executor for this exact binding may write its execution
  -- fields. The GUC is set inside the server transaction, never from graph JSON.
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
    -- A stale binding must not disturb an unrelated legacy task on this node.
    n:=jsonb_set(n,'{data}',(data-'taskId')||jsonb_build_object('status','idle'));
   END IF;
  END IF;
  nodes:=array_append(nodes,n);
 END LOOP;
 NEW.graph:=jsonb_set(NEW.graph,'{nodes}',to_jsonb(nodes));
 RETURN NEW;
END $$;
-- Project rows must already exist for node FK insertion. Creation starts with
-- an empty graph; inserts with a graph are tracked by the AFTER INSERT trigger.
CREATE TRIGGER a_canvas_node_versions BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION canvas.track_node_versions();
CREATE FUNCTION canvas.seed_node_versions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.internal_kind IS NULL AND NEW.deleted_at IS NULL THEN
 INSERT INTO canvas.node_versions(project_id,owner_id,node_id,present)
 SELECT NEW.id,NEW.owner_id,n->>'id',true FROM jsonb_array_elements(NEW.graph->'nodes') n WHERE n->>'id'<>'rhtv_meta_v1';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER canvas_seed_node_versions AFTER INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION canvas.seed_node_versions();

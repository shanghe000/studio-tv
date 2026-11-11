-- Native post-submit progress estimates are presentation state, not generation inputs.
-- Preserve all nested parameters and output metadata. Migration 017 stays immutable.
CREATE OR REPLACE FUNCTION canvas.node_semantics_index(g jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
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
   '__rhtv','title','label','modelName','modelNameEn','status','taskId','errorMsg','testMode','customBadgeText','progress','width','height','opResize','estimateTaskId','generationStartedAt','estimatedSeconds','localVideoEditTaskId'],
  'incoming',COALESCE(incoming.edges,'[]'::jsonb))),'{}'::jsonb)
 FROM jsonb_array_elements(g->'nodes') n LEFT JOIN incoming ON incoming.node_id=n->>'id'
 WHERE n->>'id'<>'rhtv_meta_v1'
$$;

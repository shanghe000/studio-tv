-- Disposable PostgreSQL only. The runner loads existing 001/002/003, then the
-- current blueprint, then this file. Test fixtures/functions are rolled back.
-- DATABASE counts reflect actual CHECK/FK/trigger/CAS behavior.
-- APPLICATION_PREDICATE counts are explicit typed-receipt selection fixtures:
-- purpose, READY and HF root binding are APPLICATION rules, not DDL rejection
-- and not implemented Go use cases. Never claim these as database guarantees.
BEGIN;
CREATE TEMP TABLE design_test_results (name text PRIMARY KEY, category text NOT NULL);

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text, category text DEFAULT 'DATABASE')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', label; END IF;
  INSERT INTO design_test_results VALUES (label, category);
END;
$$;

CREATE FUNCTION pg_temp.expect_failure(label text, statement text, expected_state text,
                                      expected_constraint text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text; actual_constraint text;
BEGIN
  BEGIN
    EXECUTE statement;
    SET CONSTRAINTS ALL IMMEDIATE; -- Exercise deferred FKs/triggers at commit boundary.
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE, actual_constraint=CONSTRAINT_NAME;
  END;
  IF actual_state IS NULL THEN RAISE EXCEPTION 'expected rejection did not occur: %', label; END IF;
  IF actual_state <> expected_state THEN
    RAISE EXCEPTION 'wrong SQLSTATE for %: expected %, got %', label, expected_state, actual_state;
  END IF;
  IF expected_constraint IS NOT NULL AND actual_constraint <> expected_constraint THEN
    RAISE EXCEPTION 'wrong constraint for %: expected %, got %', label, expected_constraint, actual_constraint;
  END IF;
  INSERT INTO design_test_results VALUES (label, 'DATABASE');
END;
$$;

SELECT pg_temp.assert_true(current_setting('server_version_num')::int BETWEEN 170000 AND 179999,
                           'runs on PostgreSQL 17');

INSERT INTO public.users(id,email,display_name) VALUES
 ('qa_owner_a','qa-a@invalid.example','Temporary A'),
 ('qa_owner_b','qa-b@invalid.example','Temporary B');
INSERT INTO public.projects(id,owner_id,name) VALUES
 ('qa_canvas_a','qa_owner_a','Canvas A'),
 ('qa_canvas_a2','qa_owner_a','Canvas A2'),
 ('qa_canvas_b','qa_owner_b','Canvas B');
INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES
 ('qa_asset_a','qa_owner_a','qa_canvas_a','a.png','IMAGE','image/png',8,repeat('a',64),'READY'),
 ('qa_asset_b','qa_owner_b','qa_canvas_b','b.png','IMAGE','image/png',8,repeat('b',64),'READY');
INSERT INTO media.blobs(id,owner_id,scope,object_key,mime_type,byte_size,checksum_sha256,state,verified_at) VALUES
 ('qa_blob_a','qa_owner_a','PRIVATE','qa/a.txt','text/plain',8,repeat('a',64),'READY',now()),
 ('qa_blob_a2','qa_owner_a','PRIVATE','qa/a2.bin','application/octet-stream',8,repeat('a',64),'READY',now()),
 ('qa_blob_b','qa_owner_b','PRIVATE','qa/b.txt','text/plain',8,repeat('b',64),'READY',now());
INSERT INTO media.model_assets(id,owner_id,project_id,name,format,entrypoint,state) VALUES
 ('qa_model_asset_a','qa_owner_a','qa_canvas_a','Model A','GLTF','scene.gltf','READY');
INSERT INTO canvas.media_refs(id,project_id,owner_id,node_key,ref_kind,asset_id) VALUES
 ('qa_canvas_ref_a','qa_canvas_a2','qa_owner_a','node-a','NODE','qa_asset_a');

INSERT INTO library.collections(owner_id) VALUES ('qa_owner_a'),('qa_owner_b');
INSERT INTO library.folders(id,owner_id,parent_id,category_code,name) VALUES
 ('qa_folder_a','qa_owner_a',NULL,'USER_OTHER','Mixed A'),
 ('qa_folder_child','qa_owner_a','qa_folder_a','USER_OTHER','Child A'),
 ('qa_folder_b','qa_owner_b',NULL,'USER_OTHER','Mixed B');
INSERT INTO library.items(id,owner_id,folder_id,category_code,kind,name,asset_id,text_content,item_type) VALUES
 ('qa_item_image','qa_owner_a','qa_folder_a','USER_OTHER','IMAGE','Image','qa_asset_a',NULL,'NODE'),
 ('qa_item_text','qa_owner_a','qa_folder_a','USER_OTHER','TEXT','Text',NULL,'saved text','NODE'),
 ('qa_gallery_a','qa_owner_a','qa_folder_a','USER_CHARACTER','IMAGE','Gallery A',NULL,NULL,'ROLE_GALLERY'),
 ('qa_gallery_b','qa_owner_b','qa_folder_b','USER_SCENE','IMAGE','Gallery B',NULL,NULL,'SCENE_GALLERY');
INSERT INTO library.item_media_refs(id,item_id,owner_id,asset_id,ref_role,sort_order) VALUES
 ('qa_gallery_image1','qa_gallery_a','qa_owner_a','qa_asset_a','GALLERY_IMAGE',0),
 ('qa_gallery_image2','qa_gallery_a','qa_owner_a','qa_asset_a','GALLERY_IMAGE',1);
INSERT INTO library.folder_media_refs(folder_id,owner_id,asset_id,sort_order) VALUES
 ('qa_folder_a','qa_owner_a','qa_asset_a',0);

INSERT INTO catalog.categories(id,namespace,code,parent_id,name_localized) VALUES
 ('qa_cat_root','APP_TAG','qa-root',NULL,'{"en":"Root"}'),
 ('qa_cat_child','APP_TAG','qa-child','qa_cat_root','{"en":"Child"}');
INSERT INTO catalog.models(id,code,name_localized) VALUES ('qa_model','qa-model','{"en":"Model"}');
INSERT INTO catalog.model_groups(id,parent_id,code,name_localized) VALUES
 ('qa_group_root',NULL,'qa-group-root','{"en":"Root"}'),
 ('qa_group_child','qa_group_root','qa-group-child','{"en":"Child"}');
INSERT INTO catalog.model_capabilities(id,model_id,node_type,active_version) VALUES
 ('qa_capability','qa_model','image','v1');
INSERT INTO catalog.model_versions(capability_id,version,parameter_schema,ui_config,default_params) VALUES
 ('qa_capability','v1','{}','[]','{"seed":42}');
INSERT INTO catalog.resources(id,kind,owner_id,scope,name_localized,active_version) VALUES
 ('qa_workflow','WORKFLOW','qa_owner_a','PRIVATE','{"en":"Workflow"}','v1'),
 ('qa_prompt','PROMPT','qa_owner_a','PRIVATE','{"en":"Prompt"}','v1'),
 ('qa_style','STYLE','qa_owner_a','PRIVATE','{"en":"Style"}','v1'),
 ('qa_skill','SKILL','qa_owner_a','PRIVATE','{"en":"Skill"}','v1'),
 ('qa_app','AI_APP','qa_owner_a','PRIVATE','{"en":"App"}','v1'),
 ('qa_voice','VOICE','qa_owner_a','PRIVATE','{"en":"Voice"}','v1');
INSERT INTO catalog.workflow_versions(resource_id,owner_key,version,graph) VALUES ('qa_workflow','qa_owner_a','v1','{"nodes":[]}');
INSERT INTO catalog.prompt_versions(resource_id,owner_key,resource_kind,version,target_type) VALUES
 ('qa_prompt','qa_owner_a','PROMPT','v1','TEXT'),('qa_style','qa_owner_a','STYLE','v1','IMAGE');
INSERT INTO catalog.skill_versions(resource_id,owner_key,version,output_type) VALUES ('qa_skill','qa_owner_a','v1','TEXT');
INSERT INTO catalog.app_versions(resource_id,owner_key,version,workflow_id,workflow_version,workflow_owner_key,inputs_schema) VALUES
 ('qa_app','qa_owner_a','v1','qa_workflow','v1','qa_owner_a','[]');
INSERT INTO catalog.voice_versions(resource_id,owner_key,version,provider_voice_code,gender) VALUES
 ('qa_voice','qa_owner_a','v1','test-only-voice','UNKNOWN');

INSERT INTO studio.hf_projects(id,owner_id,name) VALUES
 ('qa_hf_a','qa_owner_a','HF A'),('qa_hf_a2','qa_owner_a','HF A2'),('qa_hf_b','qa_owner_b','HF B');
INSERT INTO media.blob_uploads(id,owner_id,purpose,hf_project_id,blob_id,file_name,grant_id,state,expires_at,complete_deadline_at,completed_at) VALUES
 ('qa_upload_skill','qa_owner_a','SKILL',NULL,'qa_blob_a','README.md','10000000-0000-4000-8000-000000000001','READY',now()+interval '15 min',now()+interval '1 day',now()),
 ('qa_upload_hf','qa_owner_a','HF','qa_hf_a','qa_blob_a2','image.bin','10000000-0000-4000-8000-000000000002','READY',now()+interval '15 min',now()+interval '1 day',now()),
 ('qa_upload_b','qa_owner_b','SKILL',NULL,'qa_blob_b','b.md','10000000-0000-4000-8000-000000000003','READY',now()+interval '15 min',now()+interval '1 day',now()),
 ('qa_upload_pending','qa_owner_a','SKILL',NULL,'qa_blob_a','pending.md','10000000-0000-4000-8000-000000000004','PENDING',now()+interval '15 min',now()+interval '1 day',NULL);
INSERT INTO catalog.skill_files(skill_id,skill_version,owner_key,path,file_type,blob_id,upload_id) VALUES
 ('qa_skill','v1','qa_owner_a','README.md','MARKDOWN','qa_blob_a','qa_upload_skill');
INSERT INTO studio.hf_files(id,project_id,owner_id,path,mime_type,blob_id,checksum_sha256,upload_id) VALUES
 ('qa_hf_file','qa_hf_a','qa_owner_a','image.bin','application/octet-stream','qa_blob_a2',repeat('a',64),'qa_upload_hf');
INSERT INTO studio.hf_revisions(project_id,owner_id,revision,manifest_sha256) VALUES
 ('qa_hf_a','qa_owner_a',1,repeat('a',64));
INSERT INTO studio.hf_revision_files(project_id,project_revision,owner_id,path,mime_type,content_text,checksum_sha256) VALUES
 ('qa_hf_a',1,'qa_owner_a','index.html','text/html','<html></html>',repeat('a',64));

INSERT INTO execution.tasks(id,owner_id,project_id,project_revision,target_type,target_id,executor_kind,task_kind,graph_snapshot,request_hash) VALUES
 ('qa_task_a','qa_owner_a','qa_canvas_a',1,'NODE','node-a','MODEL','image','{}',repeat('a',64)),
 ('qa_task_a2','qa_owner_a','qa_canvas_a2',1,'NODE','node-a2','MODEL','image','{}',repeat('a',64)),
 ('qa_task_b','qa_owner_b','qa_canvas_b',1,'NODE','node-b','MODEL','image','{}',repeat('b',64));
INSERT INTO execution.plans(id,task_id,owner_id,project_id,node_id,position,capability_id,capability_version,invocation_type,params_snapshot) VALUES
 ('qa_plan_a','qa_task_a','qa_owner_a','qa_canvas_a','node-a',0,'qa_capability','v1','MODEL','{"seed":42}'),
 ('qa_plan_a_child','qa_task_a','qa_owner_a','qa_canvas_a','node-child',1,'qa_capability','v1','MODEL','{}'),
 ('qa_plan_a2','qa_task_a2','qa_owner_a','qa_canvas_a2','node-a2',0,'qa_capability','v1','MODEL','{}'),
 ('qa_plan_b','qa_task_b','qa_owner_b','qa_canvas_b','node-b',0,'qa_capability','v1','MODEL','{}');
INSERT INTO execution.dependencies(task_id,owner_id,plan_id,depends_on_plan_id) VALUES
 ('qa_task_a','qa_owner_a','qa_plan_a_child','qa_plan_a');
INSERT INTO execution.outputs(id,task_id,plan_id,owner_id,project_id,output_index,output_type,state,text_content) VALUES
 ('qa_output_a','qa_task_a','qa_plan_a','qa_owner_a','qa_canvas_a',0,'TEXT','SUCCEEDED','retained output'),
 ('qa_output_b','qa_task_b','qa_plan_b','qa_owner_b','qa_canvas_b',0,'TEXT','SUCCEEDED','other owner output');
INSERT INTO execution.history_heads(id,owner_id,project_id,node_id,result_count) VALUES
 ('qa_history_a','qa_owner_a','qa_canvas_a','node-a',1);
INSERT INTO execution.history_entries(id,head_id,owner_id,project_id,output_id,plan_id) VALUES
 ('qa_history_entry_a','qa_history_a','qa_owner_a','qa_canvas_a','qa_output_a','qa_plan_a');

-- Flush all fixture roots/typed active versions before negative cases so an
-- unrelated unresolved fixture cannot accidentally satisfy an expected error.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.assert_true((SELECT count(*)=2 FROM library.items WHERE folder_id='qa_folder_a' AND item_type='NODE'),
                           'MIXED folder accepts TEXT and IMAGE items');
SELECT pg_temp.assert_true((SELECT array_agg(sort_order ORDER BY sort_order)=ARRAY[0,1] FROM library.item_media_refs WHERE item_id='qa_gallery_a'),
                           'gallery image ordering is retained');
SELECT pg_temp.expect_failure('canvas media rejects foreign owner asset',
 $q$INSERT INTO canvas.media_refs(id,project_id,owner_id,node_key,ref_kind,asset_id) VALUES('bad_canvas_ref','qa_canvas_a','qa_owner_a','n','NODE','qa_asset_b')$q$,'23503');
SELECT pg_temp.expect_failure('private blob cannot become curated by owner reassignment',
 $q$UPDATE media.blobs SET owner_id=NULL,scope='CURATED' WHERE id='qa_blob_a'$q$,'23514');
SELECT pg_temp.expect_failure('core asset rejects foreign owner project',
 $q$INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES('bad_core_asset','qa_owner_a','qa_canvas_b','bad.png','IMAGE','image/png',8,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','READY')$q$,
 '23503','studio_assets_project_owner_fk');
SELECT pg_temp.expect_failure('core upload receipt rejects foreign owner asset',
 $q$INSERT INTO public.asset_uploads(id,asset_id,owner_id,grant_id,expires_at,complete_deadline_at) VALUES('bad_core_receipt','qa_asset_a','qa_owner_b','test-grant',now()+interval '1 min',now()+interval '1 day')$q$,
 '23503','studio_asset_uploads_asset_owner_fk');
SELECT pg_temp.expect_failure('verified blob object locator is immutable',
 $q$UPDATE media.blobs SET object_key='qa/replaced.txt' WHERE id='qa_blob_a'$q$,'23514');
SELECT pg_temp.expect_failure('verified blob checksum is immutable',
 $q$UPDATE media.blobs SET checksum_sha256=repeat('c',64) WHERE id='qa_blob_a'$q$,'23514');
SELECT pg_temp.expect_failure('verified blob byte size is immutable',
 $q$UPDATE media.blobs SET byte_size=9 WHERE id='qa_blob_a'$q$,'23514');
-- Soft deletion does not unfreeze verified physical object identity.
UPDATE media.blobs SET state='DELETED',deleted_at=now() WHERE id='qa_blob_a';
SELECT pg_temp.expect_failure('deleted verified blob cannot replace its physical content',
 $q$UPDATE media.blobs SET object_version='different-version' WHERE id='qa_blob_a'$q$,'23514');
UPDATE media.blobs SET state='READY',deleted_at=NULL WHERE id='qa_blob_a';
SELECT pg_temp.expect_failure('gallery media rejects foreign owner asset',
 $q$INSERT INTO library.item_media_refs(id,item_id,owner_id,asset_id,ref_role) VALUES('bad_gallery_ref','qa_gallery_a','qa_owner_a','qa_asset_b','GALLERY_IMAGE')$q$,'23503');
SELECT pg_temp.expect_failure('gallery root rejects another owner in relationship',
 $q$INSERT INTO library.item_media_refs(id,item_id,owner_id,asset_id,ref_role) VALUES('bad_gallery_root','qa_gallery_b','qa_owner_a','qa_asset_a','GALLERY_IMAGE')$q$,'23503');
SELECT pg_temp.expect_failure('folder cover rejects foreign owner asset',
 $q$INSERT INTO library.folder_media_refs(folder_id,owner_id,asset_id,sort_order) VALUES('qa_folder_a','qa_owner_a','qa_asset_b',1)$q$,'23503');
SELECT pg_temp.expect_failure('folder cover position has four-slot bound',
 $q$INSERT INTO library.folder_media_refs(folder_id,owner_id,asset_id,sort_order) VALUES('qa_folder_child','qa_owner_a','qa_asset_a',4)$q$,'23514');
SELECT pg_temp.expect_failure('folder rejects foreign owner parent',
 $q$INSERT INTO library.folders(id,owner_id,parent_id,category_code,name) VALUES('bad_parent','qa_owner_a','qa_folder_b','USER_OTHER','bad')$q$,'23503');
SELECT pg_temp.expect_failure('folder tree rejects ancestor cycle',
 $q$UPDATE library.folders SET parent_id='qa_folder_child' WHERE id='qa_folder_a'$q$,'23514');
SELECT pg_temp.expect_failure('catalog taxonomy rejects ancestor cycle',
 $q$UPDATE catalog.categories SET parent_id='qa_cat_child' WHERE id='qa_cat_root'$q$,'23514');
SELECT pg_temp.expect_failure('model group tree rejects ancestor cycle',
 $q$UPDATE catalog.model_groups SET parent_id='qa_group_child' WHERE id='qa_group_root'$q$,'23514');

SELECT pg_temp.expect_failure('resource version table must match resource kind',
 $q$INSERT INTO catalog.workflow_versions(resource_id,owner_key,version,graph) VALUES('qa_prompt','qa_owner_a','wrong','{}')$q$,'23503');
SELECT pg_temp.expect_failure('resource active version must exist at deferred boundary',
 $q$INSERT INTO catalog.resources(id,kind,owner_id,scope,name_localized,active_version) VALUES('bad_missing_version','WORKFLOW','qa_owner_a','PRIVATE','{}','absent')$q$,'23503');
SELECT pg_temp.expect_failure('resource cannot switch to missing active version',
 $q$UPDATE catalog.resources SET active_version='absent' WHERE id='qa_workflow'$q$,'23503');
SELECT pg_temp.expect_failure('model active version must exist at deferred boundary',
 $q$INSERT INTO catalog.model_capabilities(id,model_id,node_type,active_version) VALUES('bad_capability','qa_model','video','absent')$q$,'23503');

-- Actual UPDATE and DELETE attempts, including version/file tables that have
-- no downstream FK, prove rejection comes from immutability, not only FK use.
DO $$
DECLARE table_name text; row_filter text;
BEGIN
  FOR table_name,row_filter IN SELECT * FROM (VALUES
    ('catalog.model_versions', 'capability_id=''qa_capability'' AND version=''v1'''),
    ('catalog.workflow_versions', 'resource_id=''qa_workflow'' AND version=''v1'''),
    ('catalog.prompt_versions', 'resource_id=''qa_prompt'' AND version=''v1'''),
    ('catalog.skill_versions', 'resource_id=''qa_skill'' AND version=''v1'''),
    ('catalog.app_versions', 'resource_id=''qa_app'' AND version=''v1'''),
    ('catalog.voice_versions', 'resource_id=''qa_voice'' AND version=''v1'''),
    ('studio.hf_revisions', 'project_id=''qa_hf_a'' AND revision=1'),
    ('catalog.skill_files', 'skill_id=''qa_skill'' AND path=''README.md'''),
    ('studio.hf_revision_files', 'project_id=''qa_hf_a'' AND path=''index.html''')
  ) AS fixture(t,f) LOOP
    PERFORM pg_temp.expect_failure(table_name||' UPDATE is immutable',
      format('UPDATE %s SET %s WHERE %s',table_name,
        CASE WHEN table_name='studio.hf_revisions' THEN 'revision=revision'
             WHEN table_name IN ('catalog.skill_files','studio.hf_revision_files') THEN 'path=path'
             ELSE 'version=version' END,row_filter),'23514');
    PERFORM pg_temp.expect_failure(table_name||' DELETE is immutable',
      format('DELETE FROM %s WHERE %s',table_name,row_filter),'23514');
  END LOOP;
END;
$$;

SELECT pg_temp.expect_failure('plan rejects missing model configuration version',
 $q$INSERT INTO execution.plans(id,task_id,owner_id,project_id,node_id,position,capability_id,capability_version,invocation_type) VALUES('bad_plan_version','qa_task_a','qa_owner_a','qa_canvas_a','bad-node',3,'qa_capability','absent','MODEL')$q$,'23503');
SELECT pg_temp.expect_failure('plan parameters are immutable after acceptance',
 $q$UPDATE execution.plans SET params_snapshot='{"seed":99}' WHERE id='qa_plan_a'$q$,'23514');
SELECT pg_temp.expect_failure('plan configuration version is immutable after acceptance',
 $q$UPDATE execution.plans SET capability_version='v2' WHERE id='qa_plan_a'$q$,'23514');
SELECT pg_temp.expect_failure('task graph snapshot is immutable after acceptance',
 $q$UPDATE execution.tasks SET graph_snapshot='{"nodes":[]}' WHERE id='qa_task_a'$q$,'23514');
SELECT pg_temp.expect_failure('dependency cannot cross tasks with same owner',
 $q$INSERT INTO execution.dependencies(task_id,owner_id,plan_id,depends_on_plan_id) VALUES('qa_task_a','qa_owner_a','qa_plan_a','qa_plan_a2')$q$,'23503');
SELECT pg_temp.expect_failure('history cannot point to another owner output',
 $q$INSERT INTO execution.history_entries(id,head_id,owner_id,project_id,output_id,plan_id) VALUES('bad_history','qa_history_a','qa_owner_a','qa_canvas_a','qa_output_b','qa_plan_b')$q$,'23503');
SELECT pg_temp.expect_failure('output content is immutable',
 $q$UPDATE execution.outputs SET text_content='changed' WHERE id='qa_output_a'$q$,'23514');
SELECT pg_temp.expect_failure('output deletion is immutable',
 $q$DELETE FROM execution.outputs WHERE id='qa_output_a'$q$,'23514');

-- These are real CAS operations, not a claim that DDL automatically adds the
-- fence predicate to arbitrary UPDATEs or that an actual worker exists yet.
UPDATE execution.plans SET state='RUNNING',lease_owner='old-worker',lease_until=now()-interval '1 sec',fence=1 WHERE id='qa_plan_a';
WITH candidate AS (
 SELECT id FROM execution.plans WHERE id='qa_plan_a' AND lease_until<now() FOR UPDATE SKIP LOCKED
)
UPDATE execution.plans p SET lease_owner='new-worker',lease_until=now()+interval '1 min',fence=p.fence+1
FROM candidate c WHERE p.id=c.id;
SELECT pg_temp.assert_true((SELECT fence=2 AND lease_owner='new-worker' FROM execution.plans WHERE id='qa_plan_a'),
                           'expired lease claim increments fence');
WITH changed AS (
 UPDATE execution.plans SET state='SUCCEEDED' WHERE id='qa_plan_a' AND lease_owner='old-worker' AND fence=1 RETURNING id
)
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM changed),'stale worker fence CAS updates zero rows');
WITH changed AS (
 UPDATE execution.plans SET state='SUCCEEDED',lease_owner=NULL,lease_until=NULL
 WHERE id='qa_plan_a' AND lease_owner='new-worker' AND fence=2 RETURNING id
)
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM changed),'current worker fence CAS completes one row');

UPDATE execution.history_entries SET visible_node=false,visible_global=false,deleted_at=now() WHERE id='qa_history_entry_a';
UPDATE execution.history_heads SET revision=revision+1,result_count=0 WHERE id='qa_history_a';
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM execution.outputs WHERE id='qa_output_a' AND text_content='retained output'),
                           'hiding node and global history retains immutable output');

SELECT pg_temp.expect_failure('skill receipt must correspond to same owner and blob',
 $q$INSERT INTO catalog.skill_files(skill_id,skill_version,owner_key,path,file_type,blob_id,upload_id) VALUES('qa_skill','v1','qa_owner_a','foreign-receipt.md','MARKDOWN','qa_blob_a','qa_upload_b')$q$,
 '23503','skill_files_upload_owner_fk');
SELECT pg_temp.expect_failure('HF receipt must correspond to same owner and blob',
 $q$INSERT INTO studio.hf_files(id,project_id,owner_id,path,mime_type,blob_id,checksum_sha256,upload_id) VALUES('bad_hf_receipt','qa_hf_a','qa_owner_a','foreign.bin','application/octet-stream','qa_blob_a','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','qa_upload_b')$q$,
 '23503','hf_files_upload_owner_fk');
SELECT pg_temp.expect_failure('HF upload grant requires owned project',
 $q$INSERT INTO media.blob_uploads(id,owner_id,purpose,hf_project_id,blob_id,file_name,grant_id,expires_at,complete_deadline_at) VALUES('bad_hf_grant','qa_owner_a','HF','qa_hf_b','qa_blob_a','bad.bin','10000000-0000-4000-8000-000000000009',now()+interval '1 min',now()+interval '1 day')$q$,'23503');
SELECT pg_temp.expect_failure('HF purpose cannot omit its project binding',
 $q$INSERT INTO media.blob_uploads(id,owner_id,purpose,blob_id,file_name,grant_id,expires_at,complete_deadline_at) VALUES('bad_hf_missing_root','qa_owner_a','HF','qa_blob_a','bad.bin','10000000-0000-4000-8000-000000000010',now()+interval '1 min',now()+interval '1 day')$q$,'23514');
SELECT pg_temp.expect_failure('Skill purpose cannot bind an HF project',
 $q$INSERT INTO media.blob_uploads(id,owner_id,purpose,hf_project_id,blob_id,file_name,grant_id,expires_at,complete_deadline_at) VALUES('bad_skill_hf_root','qa_owner_a','SKILL','qa_hf_a','qa_blob_a','bad.md','10000000-0000-4000-8000-000000000011',now()+interval '1 min',now()+interval '1 day')$q$,'23514');

INSERT INTO assistant.conversations(id,owner_id,business) VALUES
 ('qa_hf_conversation','qa_owner_a','HYPERFRAMES');
UPDATE assistant.conversations SET hf_project_id='qa_hf_a' WHERE id='qa_hf_conversation';
SELECT pg_temp.assert_true((SELECT hf_project_id='qa_hf_a' FROM assistant.conversations WHERE id='qa_hf_conversation'),
 'HF conversation allows first binding to owned project');
SELECT pg_temp.expect_failure('HF conversation rejects rebinding to another same-owner project',
 $q$UPDATE assistant.conversations SET hf_project_id='qa_hf_a2' WHERE id='qa_hf_conversation'$q$,'23514');
SELECT pg_temp.expect_failure('HF conversation rejects clearing an established binding',
 $q$UPDATE assistant.conversations SET hf_project_id=NULL WHERE id='qa_hf_conversation'$q$,'23514');
SELECT pg_temp.expect_failure('HF conversation rejects first binding to foreign owner project',
 $q$INSERT INTO assistant.conversations(id,owner_id,business,hf_project_id) VALUES('bad_hf_conversation','qa_owner_a','HYPERFRAMES','qa_hf_b')$q$,'23503');

-- Demonstrate the intentional application-only gap: the receipt FK accepts
-- same-owner/blob links, and typed use-case lookup must additionally reject a
-- wrong purpose, HF root or non-READY receipt. No DB rejection is claimed here.
INSERT INTO catalog.skill_files(skill_id,skill_version,owner_key,path,file_type,blob_id,upload_id) VALUES
 ('qa_skill','v1','qa_owner_a','wrong-purpose.md','MARKDOWN','qa_blob_a2','qa_upload_hf'),
 ('qa_skill','v1','qa_owner_a','not-ready.md','MARKDOWN','qa_blob_a','qa_upload_pending');
INSERT INTO studio.hf_files(id,project_id,owner_id,path,mime_type,blob_id,checksum_sha256,upload_id) VALUES
 ('qa_hf_wrong_root','qa_hf_a2','qa_owner_a','wrong-root.bin','application/octet-stream','qa_blob_a2',repeat('a',64),'qa_upload_hf');
SELECT pg_temp.assert_true(EXISTS(
 SELECT 1 FROM media.blob_uploads WHERE id='qa_upload_skill' AND owner_id='qa_owner_a' AND purpose='SKILL'
   AND state='READY' AND (resource_id IS NULL OR resource_id='qa_skill') AND blob_id='qa_blob_a'),
 'typed Skill receipt predicate accepts valid fixture','APPLICATION_PREDICATE');
SELECT pg_temp.assert_true(NOT EXISTS(
 SELECT 1 FROM media.blob_uploads WHERE id='qa_upload_hf' AND owner_id='qa_owner_a' AND purpose='SKILL'
   AND state='READY' AND (resource_id IS NULL OR resource_id='qa_skill') AND blob_id='qa_blob_a2'),
 'typed Skill receipt predicate excludes HF-purpose fixture','APPLICATION_PREDICATE');
SELECT pg_temp.assert_true(NOT EXISTS(
 SELECT 1 FROM media.blob_uploads WHERE id='qa_upload_pending' AND owner_id='qa_owner_a' AND purpose='SKILL'
   AND state='READY' AND (resource_id IS NULL OR resource_id='qa_skill') AND blob_id='qa_blob_a'),
 'typed Skill receipt predicate excludes pending fixture','APPLICATION_PREDICATE');
SELECT pg_temp.assert_true(NOT EXISTS(
 SELECT 1 FROM media.blob_uploads WHERE id='qa_upload_hf' AND owner_id='qa_owner_a' AND purpose='HF'
   AND hf_project_id='qa_hf_a2' AND state='READY' AND blob_id='qa_blob_a2'),
 'typed HF receipt predicate excludes another same-owner root','APPLICATION_PREDICATE');
SELECT pg_temp.assert_true(EXISTS(
 SELECT 1 FROM media.blob_uploads WHERE id='qa_upload_hf' AND owner_id='qa_owner_a' AND purpose='HF'
   AND hf_project_id='qa_hf_a' AND state='READY' AND blob_id='qa_blob_a2'),
 'typed HF receipt predicate accepts valid root fixture','APPLICATION_PREDICATE');

SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) FILTER (WHERE category='DATABASE') AS database_checks,
       count(*) FILTER (WHERE category='APPLICATION_PREDICATE') AS application_checks
FROM design_test_results
\gset
ROLLBACK;
SELECT 'PASS schema_invariants database='||:database_checks||' application_predicates='||:application_checks;
SELECT 'PASS fixtures_rolled_back='||(count(*)=0)::text FROM public.users WHERE id IN ('qa_owner_a','qa_owner_b');

-- Sessions, conversations and Agent evidence continue to belong to the actual
-- caller. A project reference is no longer a claim that the caller owns it.
-- Each application repository authorizes that project through the local ACL.
ALTER TABLE assistant.conversations DROP CONSTRAINT conversations_project_owner_fk;
ALTER TABLE assistant.conversations ADD CONSTRAINT conversations_project_fk
 FOREIGN KEY(canvas_project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;
ALTER TABLE assistant.agent_runs DROP CONSTRAINT agent_runs_project_id_owner_id_fkey;
ALTER TABLE assistant.agent_runs ADD CONSTRAINT agent_runs_project_fk
 FOREIGN KEY(project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;
ALTER TABLE execution.tasks DROP CONSTRAINT tasks_project_id_owner_id_fkey;
ALTER TABLE execution.tasks ADD CONSTRAINT tasks_project_fk
 FOREIGN KEY(project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;
ALTER TABLE execution.tasks ADD COLUMN initiated_by text REFERENCES public.users(id);
-- Existing append-only evidence is not rewritten. NULL denotes its original
-- owner; new collaborative commands record their actual actor separately.
ALTER TABLE canvas.command_receipts ADD COLUMN actor_id text REFERENCES public.users(id);
ALTER TABLE canvas.command_receipts DROP CONSTRAINT command_receipts_owner_id_project_id_operation_key_key;
CREATE UNIQUE INDEX command_receipts_actor_key
 ON canvas.command_receipts(coalesce(actor_id,owner_id),project_id,operation,key);

-- Message attribution stays personal; asset authorization is local ACL, not
-- an equality between the message author and the referenced media owner.
ALTER TABLE assistant.message_assets DROP CONSTRAINT message_assets_asset_id_owner_id_fkey;
ALTER TABLE assistant.message_assets ADD CONSTRAINT message_assets_asset_fk
 FOREIGN KEY(asset_id) REFERENCES public.assets(id) ON DELETE RESTRICT;

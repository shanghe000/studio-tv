-- Retain immutable message/attachment/task/receipt evidence while removing
-- deleted messages from product history/context. Sequences are never reused.
ALTER TABLE assistant.messages ADD COLUMN deleted_at timestamptz;
CREATE INDEX messages_active_owner_sequence ON assistant.messages(owner_id,conversation_id,sequence,id) WHERE deleted_at IS NULL;
CREATE FUNCTION assistant.guard_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.role IS DISTINCT FROM OLD.role OR NEW.content IS DISTINCT FROM OLD.content OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'message identity and content are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RAISE EXCEPTION 'message deletion cannot change or regress' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER messages_identity_guard BEFORE UPDATE ON assistant.messages FOR EACH ROW EXECUTE FUNCTION assistant.guard_message_identity();

-- Durable canvas Agent slice, independent of legacy execution assistant tasks.
ALTER TABLE public.sessions ADD CONSTRAINT sessions_id_user_uq UNIQUE(id,user_id);
CREATE TABLE assistant.agent_runs (
 id text PRIMARY KEY,
 owner_id text NOT NULL,
 parent_session_id text NOT NULL,
 conversation_id text NOT NULL,
 project_id text NOT NULL,
 message_id text NOT NULL,
 idempotency_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 state text NOT NULL CHECK(state IN('QUEUED','RUNNING','WAITING_FOR_AUTH','SUCCEEDED','FAILED','CANCELED','TIMED_OUT','UNKNOWN')),
 credential_epoch bigint NOT NULL DEFAULT 1 CHECK(credential_epoch>0),
 auth_issued_at timestamptz NOT NULL,
 auth_token_expires_at timestamptz NOT NULL,
 auth_expires_at timestamptz NOT NULL,
 runtime_started boolean NOT NULL DEFAULT false,
 checkpoint jsonb,
 native_thread_id text,
 native_turn_id text,
 lease_token uuid,
 lease_until timestamptz,
 tool_count integer NOT NULL DEFAULT 0 CHECK(tool_count>=0),
 event_sequence bigint NOT NULL DEFAULT 0 CHECK(event_sequence>=0),
 assistant_message_id text,
 error_code text,
 usage jsonb,
 deadline timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(id,owner_id),
 UNIQUE(owner_id,conversation_id,idempotency_key),
 FOREIGN KEY(parent_session_id,owner_id) REFERENCES public.sessions(id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(conversation_id,owner_id,project_id) REFERENCES assistant.conversations(id,owner_id,canvas_project_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,owner_id) REFERENCES public.projects(id,owner_id) ON DELETE RESTRICT,
 FOREIGN KEY(message_id,conversation_id,owner_id) REFERENCES assistant.messages(id,conversation_id,owner_id) ON DELETE RESTRICT,
 FOREIGN KEY(assistant_message_id,conversation_id,owner_id) REFERENCES assistant.messages(id,conversation_id,owner_id) ON DELETE RESTRICT,
 CHECK(auth_issued_at<auth_token_expires_at AND auth_expires_at<=auth_token_expires_at AND auth_expires_at<=deadline),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK(native_turn_id IS NULL OR native_thread_id IS NOT NULL)
);
CREATE UNIQUE INDEX agent_runs_active_conversation ON assistant.agent_runs(conversation_id) WHERE state IN('QUEUED','RUNNING','WAITING_FOR_AUTH');
CREATE UNIQUE INDEX agent_runs_native_thread ON assistant.agent_runs(native_thread_id) WHERE native_thread_id IS NOT NULL;
CREATE INDEX agent_runs_queue ON assistant.agent_runs(created_at,id) WHERE state IN('QUEUED','RUNNING');

CREATE TABLE assistant.agent_tool_calls (
 run_id text NOT NULL,
 owner_id text NOT NULL,
 native_call_id text NOT NULL,
 native_thread_id text NOT NULL,
 native_turn_id text NOT NULL,
 tool_name text NOT NULL,
 namespace text NOT NULL,
 arguments jsonb NOT NULL,
 argument_hash text NOT NULL CHECK(argument_hash ~ '^[0-9a-f]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 operation_key uuid NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('PENDING','SUCCEEDED','FAILED')),
 result jsonb,
 success boolean NOT NULL DEFAULT false,
 http_status integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 PRIMARY KEY(run_id,native_call_id),
 FOREIGN KEY(run_id,owner_id) REFERENCES assistant.agent_runs(id,owner_id) ON DELETE RESTRICT,
 CHECK((state='PENDING')=(result IS NULL)),
 CHECK(success=(state='SUCCEEDED'))
);
CREATE TABLE assistant.agent_events (
 run_id text NOT NULL,
 owner_id text NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),
 type text NOT NULL CHECK(type IN('run.state.changed','tool.started','tool.completed','tool.failed','message.delta','task.linked')),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
 occurred_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,sequence),
 FOREIGN KEY(run_id,owner_id) REFERENCES assistant.agent_runs(id,owner_id) ON DELETE RESTRICT
);

CREATE FUNCTION assistant.guard_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.parent_session_id IS DISTINCT FROM OLD.parent_session_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.deadline IS DISTINCT FROM OLD.deadline OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'agent binding and selection are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.credential_epoch<OLD.credential_epoch OR NEW.auth_issued_at<OLD.auth_issued_at OR NEW.auth_token_expires_at<OLD.auth_token_expires_at OR NEW.event_sequence<OLD.event_sequence OR NEW.tool_count<OLD.tool_count OR (OLD.runtime_started AND NOT NEW.runtime_started) OR (OLD.native_thread_id IS NOT NULL AND NEW.native_thread_id IS DISTINCT FROM OLD.native_thread_id) OR (OLD.native_turn_id IS NOT NULL AND NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id) THEN
  RAISE EXCEPTION 'agent evidence cannot regress' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_run_identity BEFORE UPDATE ON assistant.agent_runs FOR EACH ROW EXECUTE FUNCTION assistant.guard_agent_identity();
CREATE FUNCTION assistant.guard_agent_tool() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent tool evidence is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.native_call_id IS DISTINCT FROM OLD.native_call_id OR NEW.native_thread_id IS DISTINCT FROM OLD.native_thread_id OR NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id OR NEW.tool_name IS DISTINCT FROM OLD.tool_name OR NEW.namespace IS DISTINCT FROM OLD.namespace OR NEW.arguments IS DISTINCT FROM OLD.arguments OR NEW.argument_hash IS DISTINCT FROM OLD.argument_hash OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.operation_key IS DISTINCT FROM OLD.operation_key OR OLD.state<>'PENDING' THEN
  RAISE EXCEPTION 'agent tool identity and terminal receipt are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_tool_identity BEFORE UPDATE OR DELETE ON assistant.agent_tool_calls FOR EACH ROW EXECUTE FUNCTION assistant.guard_agent_tool();
CREATE TRIGGER agent_events_immutable BEFORE UPDATE OR DELETE ON assistant.agent_events FOR EACH ROW EXECUTE FUNCTION canvas.guard_command_evidence();

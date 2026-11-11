CREATE TABLE users (
  id text PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
  display_name text NOT NULL, locale text NOT NULL DEFAULT 'zh-CN',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb, disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_session ON refresh_tokens(session_id);
CREATE TABLE projects (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), name text NOT NULL,
  cover_asset_id text, pinned boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  graph jsonb NOT NULL DEFAULT '{"schemaVersion":"1","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX projects_owner_updated ON projects(owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE assets (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), project_id text NOT NULL REFERENCES projects(id),
  file_name text NOT NULL, kind text NOT NULL CHECK(kind IN ('IMAGE','VIDEO','AUDIO')),
  mime_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size > 0), checksum_sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'UPLOADING' CHECK(state IN ('UPLOADING','PROCESSING','READY','REJECTED','DELETED')),
  width integer, height integer, duration_seconds double precision,
  rejection_code text, storage_key text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX assets_owner_project ON assets(owner_id,project_id) WHERE deleted_at IS NULL;
CREATE TABLE asset_uploads (
  id text PRIMARY KEY, asset_id text NOT NULL UNIQUE REFERENCES assets(id), owner_id text NOT NULL REFERENCES users(id),
  grant_id text NOT NULL, expires_at timestamptz NOT NULL, complete_deadline_at timestamptz NOT NULL,
  uploaded_at timestamptz, object_etag text, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency_keys (
  owner_id text NOT NULL REFERENCES users(id), operation text NOT NULL, key uuid NOT NULL,
  request_hash text NOT NULL, response_status integer NOT NULL, response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,operation,key)
);

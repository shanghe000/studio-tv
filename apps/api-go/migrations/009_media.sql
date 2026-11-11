-- Actual imported/model and locally processed asset provenance, shared by the
-- existing immutable assets and execution ledger; no parallel media job table.
ALTER TABLE public.assets ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(provenance)='object');
CREATE SCHEMA media;
CREATE TABLE media.file_receipts (
 owner_id text NOT NULL REFERENCES public.users(id),
 idempotency_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 asset_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,idempotency_key),
 FOREIGN KEY(asset_id,owner_id) REFERENCES public.assets(id,owner_id)
);
CREATE TABLE media.studio_outputs(
 task_id text PRIMARY KEY,
 owner_id text NOT NULL,
 file_name text NOT NULL,
 mime_type text NOT NULL CHECK(mime_type IN('video/mp4','video/webm','video/quicktime')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 536870912),
 duration_ms bigint NOT NULL CHECK(duration_ms>0),
 width integer NOT NULL CHECK(width BETWEEN 2 AND 3840),
 height integer NOT NULL CHECK(height BETWEEN 2 AND 2160),
 checksum_sha256 text NOT NULL CHECK(length(checksum_sha256)=64),
 FOREIGN KEY(task_id,owner_id) REFERENCES execution.tasks(id,owner_id)
);

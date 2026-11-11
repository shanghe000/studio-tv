-- Additive migration: preserve existing projects/assets/users and retire
-- password sessions without associating accounts by email.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN avatar_url text;
ALTER TABLE sessions ADD COLUMN ipac_issuer text;
ALTER TABLE sessions ADD COLUMN ipac_subject text;
ALTER TABLE sessions ADD COLUMN ipac_session_id text;
ALTER TABLE sessions ADD COLUMN ipac_session_version bigint;
CREATE TABLE federated_identities (
  issuer text NOT NULL, subject_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider = 'feishu'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject_id), UNIQUE (user_id, issuer)
);
CREATE TABLE oidc_login_transactions (
  token_hash text PRIMARY KEY,
  transaction jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_transaction_expiry ON oidc_login_transactions(expires_at);
UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE ipac_issuer IS NULL;

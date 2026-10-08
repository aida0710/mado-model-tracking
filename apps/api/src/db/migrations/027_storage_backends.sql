-- Artifact storage backends configured by global administrators. Backends are identified by an
-- immutable name, so artifacts.backend, artifact_uploads.backend and projects.artifact_backend keep
-- storing names. The environment backends 'filesystem' and 's3' are never written here: their
-- secrets stay in the environment and they are listed read-only at runtime.
ALTER TABLE projects DROP CONSTRAINT projects_artifact_backend_check;
ALTER TABLE projects ADD CONSTRAINT projects_artifact_backend_name
  CHECK (artifact_backend ~ '^[a-z0-9][a-z0-9-]{0,62}$');
ALTER TABLE artifacts DROP CONSTRAINT artifacts_backend_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_backend_name
  CHECK (backend ~ '^[a-z0-9][a-z0-9-]{0,62}$');
-- Changing where a backend stores objects is refused while any Artifact refers to it.
CREATE INDEX artifacts_backend_idx ON artifacts(backend);

CREATE TABLE storage_backends (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  kind text NOT NULL CHECK (kind IN ('filesystem','s3')),
  -- filesystem: {rootPath}; s3: {endpoint?, region, bucket, prefix, pathStyle, signatureVersion,
  -- tlsVerify, checksumMode, multipartPartSizeBytes}. Never contains secrets.
  config jsonb NOT NULL,
  ca_bundle text,
  access_key_id text,
  -- AES-256-GCM payload (version, nonce, ciphertext, tag) encrypted with MMT_STORAGE_SECRET_KEY.
  secret_encrypted bytea,
  -- Fingerprint of the key that encrypted secret_encrypted, to detect a changed key.
  secret_key_id text,
  enabled boolean NOT NULL DEFAULT true,
  -- Incremented on every update so the in-memory registry never applies an older row last.
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (name NOT IN ('filesystem','s3')),
  CHECK ((secret_encrypted IS NULL) = (secret_key_id IS NULL)),
  CHECK ((access_key_id IS NULL) = (secret_encrypted IS NULL)),
  CHECK (kind = 's3' OR (access_key_id IS NULL AND ca_bundle IS NULL))
);

-- A single row; without it the default backend for new Projects is 'filesystem'.
CREATE TABLE storage_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_backend text NOT NULL CHECK (default_backend ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

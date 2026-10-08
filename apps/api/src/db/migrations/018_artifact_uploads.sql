-- Resumable Artifact upload sessions. The registered Artifact reuses the upload id, so completing
-- the same session twice cannot create a second Artifact.
CREATE TABLE artifact_uploads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  run_id uuid,
  path text NOT NULL CHECK (octet_length(path) BETWEEN 1 AND 1024),
  -- Immutable storage location name; later storage registries refer to it by this name.
  backend text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  expected_size bigint NOT NULL CHECK (expected_size > 0),
  expected_sha256 text CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  part_size bigint NOT NULL CHECK (part_size > 0),
  part_count integer NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','verifying','completed','aborted','expired','failed')),
  backend_upload_id text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_by_token_id uuid REFERENCES api_tokens(id),
  -- MLflow multipart uploads record the artifact path owner here to map the completed Artifact.
  owner_kind text CHECK (owner_kind IN ('run','model')),
  owner_id text,
  artifact_id uuid,
  error text,
  -- The finalizer holds a lease instead of a long transaction while it reads the whole object.
  finalizer_lease_id uuid,
  finalizer_locked_at timestamptz,
  finalizer_attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_kind IS NULL) = (owner_id IS NULL)),
  CHECK ((status = 'completed') = (artifact_id IS NOT NULL)),
  FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),
  FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id)
);
CREATE INDEX artifact_uploads_project_status ON artifact_uploads(project_id,status,expires_at);
-- The finalizer and expiry sweeper scan by status across projects.
CREATE INDEX artifact_uploads_status ON artifact_uploads(status,expires_at);
CREATE TABLE artifact_upload_parts (
  upload_id uuid NOT NULL REFERENCES artifact_uploads(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size bigint NOT NULL CHECK (size >= 0),
  sha256 text NOT NULL,
  etag text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(upload_id,part_number)
);

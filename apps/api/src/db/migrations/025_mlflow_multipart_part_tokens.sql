-- MLflow multipart uploads reuse artifact upload sessions. The SDK sends part requests without
-- Authorization, so each MLflow session carries its own part token; only its hash is stored and
-- it is valid for the session's lifetime.
ALTER TABLE artifact_uploads ADD COLUMN part_token_hash text UNIQUE
  CHECK (part_token_hash ~ '^[0-9a-f]{64}$');
-- MLflow's mpu/create sends only the part count, so the size is known once every part arrived.
-- An MLflow session records both sizes when it moves to verifying.
ALTER TABLE artifact_uploads ALTER COLUMN expected_size DROP NOT NULL;
ALTER TABLE artifact_uploads ALTER COLUMN part_size DROP NOT NULL;
ALTER TABLE artifact_uploads ADD CONSTRAINT artifact_uploads_mlflow_session
  CHECK ((owner_kind IS NULL) = (part_token_hash IS NULL));
ALTER TABLE artifact_uploads ADD CONSTRAINT artifact_uploads_sizes_known
  CHECK (
    (expected_size IS NOT NULL AND part_size IS NOT NULL)
    OR (owner_kind IS NOT NULL AND status IN ('open','aborted','expired'))
  );

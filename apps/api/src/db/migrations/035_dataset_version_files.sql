-- A DatasetVersion either points elsewhere ('reference': uri and digest supplied by the client,
-- as MLflow log_inputs and plugin imports do) or is made of Artifacts listed in
-- dataset_version_files ('artifacts'). Versions are immutable (dataset_versions_immutable), so the
-- counts are written by the same INSERT and never updated; a reference version has no counts.
ALTER TABLE dataset_versions
  ADD COLUMN content_kind text NOT NULL DEFAULT 'reference'
    CHECK (content_kind IN ('reference','artifacts')),
  ADD COLUMN file_count integer CHECK (file_count >= 0),
  ADD COLUMN total_size bigint CHECK (total_size >= 0),
  ADD CONSTRAINT dataset_versions_content_counts CHECK (
    (content_kind='reference' AND file_count IS NULL AND total_size IS NULL)
    OR (content_kind='artifacts' AND file_count IS NOT NULL AND total_size IS NOT NULL)
  );

-- size and sha256 are copied from the Artifact so the manifest digest can be recomputed from this
-- table alone. The C collation orders paths by UTF-8 bytes, which is the order the digest uses and
-- the order file lists page in.
CREATE TABLE dataset_version_files (
  dataset_version_id uuid NOT NULL,
  project_id uuid NOT NULL,
  path text COLLATE "C" NOT NULL,
  artifact_id uuid NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  sha256 text NOT NULL,
  PRIMARY KEY (dataset_version_id,path),
  FOREIGN KEY (dataset_version_id,project_id) REFERENCES dataset_versions(id,project_id),
  -- No cascade: an Artifact a DatasetVersion lists cannot be deleted from under the version.
  FOREIGN KEY (artifact_id,project_id) REFERENCES artifacts(id,project_id)
);
CREATE TRIGGER dataset_version_files_immutable BEFORE UPDATE ON dataset_version_files
  FOR EACH ROW EXECUTE FUNCTION reject_version_update();
-- Finds the versions that still reference an Artifact (deletion and garbage collection).
CREATE INDEX dataset_version_files_artifact ON dataset_version_files(artifact_id);

-- GET /artifacts/by-digest looks up a stored Artifact with the same content before uploading again.
CREATE INDEX artifacts_project_digest ON artifacts(project_id,sha256,size);

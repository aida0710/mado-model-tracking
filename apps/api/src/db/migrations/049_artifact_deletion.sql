-- Artifact deletion is two-phase. DELETE /projects/:p/artifacts/:a (and MLflow delete_artifacts)
-- sets artifacts.deleted_at, which hides the Artifact from listings and content at once; the
-- ArtifactGarbageCollector removes the blob after MMT_ARTIFACT_DELETE_GRACE_DAYS. The row stays as
-- a tombstone so storage keys, audit events and finished upload sessions keep resolving.
ALTER TABLE artifacts ADD COLUMN deleted_at timestamptz;
-- The collector scans only deleted rows, oldest first.
CREATE INDEX artifacts_deleted ON artifacts(deleted_at) WHERE deleted_at IS NOT NULL;

-- Who deleted the Artifact and how far the blob removal got. Kept out of the artifacts row so that
-- Artifact responses (SELECT * FROM artifacts) only gain deletedAt.
CREATE TABLE artifact_deletions (
  artifact_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  deleted_by uuid REFERENCES users(id),
  -- 'native' is the Artifact API, 'mlflow' is MLflow delete_artifacts, 'derived' is a server-side
  -- preview removed together with its source Artifact.
  origin text NOT NULL CHECK (origin IN ('native','mlflow','derived')),
  blob_removed_at timestamptz,
  removal_attempts integer NOT NULL DEFAULT 0 CHECK (removal_attempts >= 0),
  -- An error name such as NoSuchBucket or EACCES, never storage locations or credentials.
  last_removal_error text CHECK (last_removal_error IS NULL OR length(last_removal_error) <= 64),
  FOREIGN KEY (artifact_id, project_id) REFERENCES artifacts(id, project_id)
);
CREATE INDEX artifact_deletions_pending ON artifact_deletions(artifact_id) WHERE blob_removed_at IS NULL;

-- Deletion is final: there is no restore, because the blob may already be gone.
CREATE FUNCTION guard_artifact_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Artifact deletion is final' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifacts_deletion_final BEFORE UPDATE OF deleted_at ON artifacts
  FOR EACH ROW EXECUTE FUNCTION guard_artifact_deletion();

-- MLflow delete_artifacts on a Run path leaves a mapping without an Artifact. It hides older
-- native uploads at that path (which would otherwise become current) and Artifacts kept because
-- a registered model version references them. A later MLflow upload to the path replaces it.
ALTER TABLE mlflow_artifact_paths ALTER COLUMN artifact_id DROP NOT NULL;

-- New references to a deleted Artifact are refused, whichever API writes them. The deleting
-- transaction locks the Artifact FOR UPDATE before it checks references; FOR KEY SHARE here waits
-- for that lock and then reads the committed deleted_at, so a reference and a deletion committing
-- at the same time cannot both succeed. 23503 reaches clients as 422 invalid_reference.
CREATE FUNCTION reject_deleted_artifact_references(artifact_ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM (SELECT deleted_at FROM artifacts WHERE id = ANY(artifact_ids) FOR KEY SHARE) locked
    WHERE locked.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A deleted Artifact cannot be referenced' USING ERRCODE='23503';
  END IF;
END;
$$;

-- Artifact ids listed in a JSON array of objects with an artifactId field (MLflow manifests).
CREATE FUNCTION manifest_artifact_ids(manifest jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg((entry->>'artifactId')::uuid), '{}')
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(manifest)='array' THEN manifest ELSE '[]'::jsonb END) entry
  WHERE entry->>'artifactId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

CREATE FUNCTION reject_deleted_model_version_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reject_deleted_artifact_references(
    array_remove(ARRAY[NEW.artifact_id], NULL)
    || manifest_artifact_ids(NEW.metadata #> '{mlflow,artifactManifest}'));
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_versions_live_artifacts BEFORE INSERT OR UPDATE OF artifact_id, metadata
  ON model_versions FOR EACH ROW EXECUTE FUNCTION reject_deleted_model_version_artifacts();

-- CodeSource {kind:'artifact'} and Singularity/Apptainer runtimes name their Artifact.
CREATE FUNCTION reject_deleted_code_version_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reject_deleted_artifact_references(
    manifest_artifact_ids(jsonb_build_array(NEW.source, NEW.runtime)));
  RETURN NEW;
END;
$$;
CREATE TRIGGER code_versions_live_artifacts BEFORE INSERT OR UPDATE OF source, runtime
  ON code_versions FOR EACH ROW EXECUTE FUNCTION reject_deleted_code_version_artifacts();

CREATE FUNCTION reject_deleted_dataset_file_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reject_deleted_artifact_references(ARRAY[NEW.artifact_id]);
  RETURN NEW;
END;
$$;
CREATE TRIGGER dataset_version_files_live_artifact BEFORE INSERT
  ON dataset_version_files FOR EACH ROW EXECUTE FUNCTION reject_deleted_dataset_file_artifact();

CREATE FUNCTION reject_deleted_checkpoint_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reject_deleted_artifact_references(NEW.artifact_ids);
  RETURN NEW;
END;
$$;
-- Hiding a checkpoint (retained=false) does not fire this, so its deleted files do not block it.
CREATE TRIGGER run_checkpoints_live_artifacts BEFORE INSERT OR UPDATE OF artifact_ids
  ON run_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_deleted_checkpoint_artifacts();

CREATE FUNCTION reject_deleted_run_media_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reject_deleted_artifact_references(
    array_remove(ARRAY[NEW.artifact_id, NEW.thumbnail_artifact_id], NULL));
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_media_live_artifacts BEFORE INSERT OR UPDATE OF thumbnail_artifact_id
  ON run_media FOR EACH ROW EXECUTE FUNCTION reject_deleted_run_media_artifacts();

CREATE FUNCTION reject_deleted_mlflow_path_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM reject_deleted_artifact_references(array_remove(ARRAY[NEW.artifact_id], NULL));
  RETURN NEW;
END;
$$;
CREATE TRIGGER mlflow_artifact_paths_live_artifact BEFORE INSERT OR UPDATE OF artifact_id
  ON mlflow_artifact_paths FOR EACH ROW EXECUTE FUNCTION reject_deleted_mlflow_path_artifact();

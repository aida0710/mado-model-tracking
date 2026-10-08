-- Media files (audio, image, video, table) of a Run at a key and step, so a step slider or a
-- comparison of several Runs reads one indexed query instead of parsing Artifact paths.
-- source='native' rows come from POST /runs/:r/media; source='mlflow' rows are indexed from
-- MLflow log_image(key=, step=) files when they are saved. MLflow log_table files are read from
-- the Run's mlflow.loggedArtifacts tag at listing time and are not stored here.
CREATE TABLE run_media (
  -- The client may choose the id so that an offline resend is idempotent.
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 250),
  step bigint NOT NULL CHECK (step >= 0),
  kind text NOT NULL CHECK (kind IN ('audio','image','video','table')),
  artifact_id uuid NOT NULL,
  -- MLflow's compressed .webp of the same image, attached when either file arrives second.
  thumbnail_artifact_id uuid,
  caption text CHECK (caption IS NULL OR char_length(caption) <= 1000),
  -- The 16KiB limit on the JSON text is checked by the API.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  source text NOT NULL CHECK (source IN ('native','mlflow')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, key, step, artifact_id),
  FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id),
  -- A media row describes its Artifact, so it goes away when the Artifact is deleted.
  FOREIGN KEY (artifact_id, project_id) REFERENCES artifacts(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (thumbnail_artifact_id, project_id) REFERENCES artifacts(id, project_id)
    ON DELETE SET NULL (thumbnail_artifact_id)
);
CREATE INDEX run_media_run_key_step ON run_media(run_id, key, step);
CREATE INDEX run_media_project_key ON run_media(project_id, key);
-- The indexer looks up the image row of a thumbnail by the image's Artifact.
CREATE INDEX run_media_artifact ON run_media(artifact_id);

-- Rows are immutable except for attaching, replacing or clearing the thumbnail.
CREATE FUNCTION guard_run_media_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.run_id<>OLD.run_id
    OR NEW.key<>OLD.key OR NEW.step<>OLD.step OR NEW.kind<>OLD.kind
    OR NEW.artifact_id<>OLD.artifact_id OR NEW.caption IS DISTINCT FROM OLD.caption
    OR NEW.metadata<>OLD.metadata OR NEW.source<>OLD.source OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Run media are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_media_immutable BEFORE UPDATE ON run_media
  FOR EACH ROW EXECUTE FUNCTION guard_run_media_change();

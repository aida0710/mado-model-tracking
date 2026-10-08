-- Checkpoints a training/finetuning Run saved so that a later Run can continue from them.
-- source='native' is one tar Artifact registered by the SDK (manifest lists the files inside it);
-- source='mlflow' collects the files MLflow logged under checkpoints/step-<N>/ (one Artifact each).
-- retained=false hides a checkpoint beyond the keep count from the default list; its Artifacts
-- are not deleted here (Artifact deletion belongs to the lifecycle GC).
CREATE TABLE run_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step bigint NOT NULL CHECK (step >= 0),
  source text NOT NULL CHECK (source IN ('native','mlflow')),
  artifact_ids uuid[] NOT NULL CHECK (cardinality(artifact_ids) >= 1),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object' AND jsonb_typeof(manifest->'files')='array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  retained boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step),
  UNIQUE (id, project_id),
  FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id),
  CHECK (source<>'native' OR cardinality(artifact_ids)=1)
);
CREATE INDEX run_checkpoints_run_step ON run_checkpoints(run_id, step DESC);

-- A checkpoint is final once its Run has ended after it was created: the Run is terminal now, or
-- it was reopened (run_resume_events) after ending at or after the checkpoint's creation.
CREATE FUNCTION run_checkpoint_is_final(checkpoint_run_id uuid, checkpoint_created_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM runs WHERE id=checkpoint_run_id AND status IN ('finished','failed','canceled')
  ) OR EXISTS(
    SELECT 1 FROM run_resume_events
    WHERE run_id=checkpoint_run_id AND previous_ended_at >= checkpoint_created_at
  );
$$;

-- Versions are immutable. The only changes are hiding a checkpoint (retained true -> false) and,
-- for an MLflow checkpoint that is not final yet, adding or replacing its files.
CREATE FUNCTION guard_run_checkpoint_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Run checkpoints cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.run_id<>OLD.run_id
    OR NEW.step<>OLD.step OR NEW.source<>OLD.source OR NEW.metadata<>OLD.metadata
    OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Run checkpoints are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.retained AND NOT OLD.retained THEN
    RAISE EXCEPTION 'A hidden Run checkpoint cannot be retained again' USING ERRCODE='23514';
  END IF;
  IF NEW.artifact_ids IS DISTINCT FROM OLD.artifact_ids OR NEW.manifest IS DISTINCT FROM OLD.manifest THEN
    IF OLD.source<>'mlflow' OR run_checkpoint_is_final(OLD.run_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Run checkpoint files are final' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_checkpoints_immutable BEFORE UPDATE OR DELETE ON run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION guard_run_checkpoint_change();

-- The checkpoint a Run continues from. The composite key keeps it inside the Run's Project.
ALTER TABLE runs ADD COLUMN resume_checkpoint_id uuid,
  ADD CONSTRAINT runs_resume_checkpoint FOREIGN KEY (resume_checkpoint_id, project_id)
    REFERENCES run_checkpoints(id, project_id);
CREATE INDEX runs_resume_checkpoint ON runs(resume_checkpoint_id) WHERE resume_checkpoint_id IS NOT NULL;

-- resume_checkpoint_id is set once while the Run is being created (before any Job exists) and never
-- changes afterwards. environment.resume is owned by the server: it mirrors the checkpoint and is
-- kept as it was when a client replaces the environment, so it always describes the pinned input.
CREATE FUNCTION guard_run_resume_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.resume_checkpoint_id IS DISTINCT FROM OLD.resume_checkpoint_id THEN
    IF OLD.resume_checkpoint_id IS NOT NULL OR EXISTS(SELECT 1 FROM jobs WHERE run_id=NEW.id) THEN
      RAISE EXCEPTION 'Run resume checkpoint is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.environment->'resume'->>'checkpointId' IS DISTINCT FROM NEW.resume_checkpoint_id::text THEN
      RAISE EXCEPTION 'Run environment.resume must describe the resume checkpoint' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.resume_checkpoint_id IS NULL THEN
    NEW.environment = NEW.environment - 'resume';
  ELSIF TG_OP='UPDATE' AND OLD.environment ? 'resume' THEN
    NEW.environment = jsonb_set(NEW.environment, '{resume}', OLD.environment->'resume');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runs_resume_checkpoint BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_run_resume_checkpoint();

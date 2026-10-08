-- Evaluation inputs are split by role. The upstream outputs (for example an inference Run's
-- predictions) differ per model version, so evaluation conditions are matched on the remaining
-- "reference set" (input_dataset_version_ids minus upstream_dataset_version_ids) only.
ALTER TABLE runs
  ADD COLUMN upstream_dataset_version_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT runs_upstream_inputs_subset
    CHECK (upstream_dataset_version_ids <@ input_dataset_version_ids);

-- The role split decides which earlier evaluations a Run is compared with, so it is fixed at
-- creation like the code version and execution snapshot.
CREATE FUNCTION reject_run_upstream_inputs_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.upstream_dataset_version_ids IS DISTINCT FROM NEW.upstream_dataset_version_ids THEN
    RAISE EXCEPTION 'Run upstream dataset inputs are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runs_upstream_inputs_immutable BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION reject_run_upstream_inputs_update();

-- Serves "the latest finished evaluation of this model version" for baseline comparison.
CREATE INDEX runs_latest_model_evaluation ON runs
  (project_id, model_version_id, ended_at DESC NULLS LAST, id DESC)
  WHERE kind = 'evaluation' AND status = 'finished' AND lifecycle_stage = 'active';

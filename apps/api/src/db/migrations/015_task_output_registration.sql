-- Task-side "register the output model on success". The Task keeps an editable setting; each Run
-- keeps the copy taken at launch so later Task edits never change what a finished Run registers.
ALTER TABLE experiment_tasks ADD COLUMN output_model jsonb
  CHECK (output_model IS NULL OR jsonb_typeof(output_model)='object');
ALTER TABLE runs ADD COLUMN output_model_registration jsonb
  CHECK (output_model_registration IS NULL OR jsonb_typeof(output_model_registration)='object');

-- The copy is taken here rather than in the service because launch and Job retry share
-- RunService.insertRun: a retry inherits the parent Run's copy (the Task may have been edited
-- since), a launch copies the Task row at the revision it locked. Test executions run the test
-- command, so they never register a model.
CREATE FUNCTION guard_run_output_model_registration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.output_model_registration IS DISTINCT FROM OLD.output_model_registration THEN
      RAISE EXCEPTION 'Run output model registration is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  NEW.output_model_registration=NULL;
  IF NEW.task_id IS NULL OR NEW.execution_mode<>'run' THEN RETURN NEW; END IF;
  SELECT parent.output_model_registration INTO NEW.output_model_registration FROM runs parent
    WHERE parent.id=NEW.parent_run_id AND parent.project_id=NEW.project_id
      AND parent.task_id=NEW.task_id AND parent.task_revision=NEW.task_revision;
  IF FOUND THEN RETURN NEW; END IF;
  SELECT task.output_model INTO NEW.output_model_registration FROM experiment_tasks task
    WHERE task.id=NEW.task_id AND task.project_id=NEW.project_id AND task.revision=NEW.task_revision;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runs_output_model_registration BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION guard_run_output_model_registration();

-- One Task-side outcome per Run. The primary key makes a resent completion (or an MLflow Run
-- that finishes again after being reopened) a no-op instead of a second version.
CREATE TABLE run_output_registrations (
  run_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('registered','failed','skipped')),
  model_version_id uuid,
  error text CHECK (error IS NULL OR length(error) BETWEEN 1 AND 200),
  reason text CHECK (reason IS NULL OR reason='already_registered_by_run'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,project_id) REFERENCES runs(id,project_id),
  CHECK (
    (status='registered' AND model_version_id IS NOT NULL AND error IS NULL AND reason IS NULL)
    OR (status='skipped' AND model_version_id IS NOT NULL AND error IS NULL AND reason IS NOT NULL)
    OR (status='failed' AND model_version_id IS NULL AND error IS NOT NULL AND reason IS NULL)
  )
);

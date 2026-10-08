-- Hyperparameter sweeps: each trial is an ordinary Task launch (Run + Job) owned by the sweep.
-- The search definition is fixed at creation; changing it means creating a new sweep, so that
-- every trial of one sweep was suggested from the same space, objective and Task revision.
CREATE TABLE sweeps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
  task_id uuid NOT NULL REFERENCES experiment_tasks(id),
  -- Trials launch only while the Task still has this revision; otherwise the sweep pauses.
  task_revision integer NOT NULL,
  experiment_id uuid NOT NULL REFERENCES experiments(id),
  method text NOT NULL CHECK(method IN ('grid','random','bayes')),
  search_space jsonb NOT NULL,
  -- {metric, goal: minimize|maximize, aggregation: last|min|max}
  objective jsonb NOT NULL,
  max_trials integer NOT NULL CHECK(max_trials BETWEEN 1 AND 10000),
  parallelism integer NOT NULL CHECK(parallelism BETWEEN 1 AND 100),
  -- {type: hyperband, minIter, eta, maxIter?}; NULL disables early stopping.
  early_stopping jsonb,
  -- The suggestion PRNG keeps 32 bits of state.
  seed bigint NOT NULL CHECK(seed BETWEEN 0 AND 4294967295),
  -- NULL uses the Task's target and GPUs at launch time.
  target_id uuid REFERENCES compute_targets(id),
  gpu_ids text[],
  status text NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','paused','finished','canceled','failed')),
  status_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(id,project_id),
  CHECK((status IN ('finished','canceled','failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX sweeps_project_created ON sweeps(project_id,created_at DESC,id DESC);
-- The scheduler only visits sweeps that can still launch or stop trials.
CREATE INDEX sweeps_active ON sweeps(status) WHERE status IN ('running','paused');

CREATE FUNCTION reject_sweep_definition_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.task_revision IS DISTINCT FROM NEW.task_revision
    OR OLD.experiment_id IS DISTINCT FROM NEW.experiment_id
    OR OLD.method IS DISTINCT FROM NEW.method
    OR OLD.search_space IS DISTINCT FROM NEW.search_space
    OR OLD.objective IS DISTINCT FROM NEW.objective
    OR OLD.early_stopping IS DISTINCT FROM NEW.early_stopping
    OR OLD.seed IS DISTINCT FROM NEW.seed
    OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'Sweep definitions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sweeps_definition_immutable BEFORE UPDATE ON sweeps
  FOR EACH ROW EXECUTE FUNCTION reject_sweep_definition_update();

CREATE TABLE sweep_trials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sweep_id uuid NOT NULL,
  project_id uuid NOT NULL,
  trial_index integer NOT NULL CHECK(trial_index >= 0),
  parameters jsonb NOT NULL,
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','running','finished','failed','canceled','early_stopped')),
  objective_value double precision,
  objective_step bigint,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE(sweep_id,trial_index),
  FOREIGN KEY(sweep_id,project_id) REFERENCES sweeps(id,project_id)
);
CREATE INDEX sweep_trials_state ON sweep_trials(sweep_id,state);

CREATE FUNCTION reject_sweep_trial_identity_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sweep_id IS DISTINCT FROM NEW.sweep_id
    OR OLD.trial_index IS DISTINCT FROM NEW.trial_index
    OR OLD.parameters IS DISTINCT FROM NEW.parameters
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.job_id IS DISTINCT FROM NEW.job_id THEN
    RAISE EXCEPTION 'Sweep trial parameters and Run are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sweep_trials_identity_immutable BEFORE UPDATE ON sweep_trials
  FOR EACH ROW EXECUTE FUNCTION reject_sweep_trial_identity_update();

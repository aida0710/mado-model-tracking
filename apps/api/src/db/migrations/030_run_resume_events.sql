-- Each reopening of an ended Run (native resume, MLflow update-run RUNNING, offline sync).
-- The first running segment starts at runs.started_at and has no row; segment N+1 starts at
-- the Nth resumed_at and ends at the next row's previous_ended_at (or runs.ended_at).
-- max_step_at_resume is the largest metric step before reopening, so step-axis charts can mark
-- where the continuation begins. actor_* are NULL only for system-driven writes.
CREATE TABLE run_resume_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  resumed_at timestamptz NOT NULL DEFAULT now(),
  previous_status text NOT NULL CHECK (previous_status IN ('finished','failed','canceled')),
  previous_ended_at timestamptz,
  max_step_at_resume bigint,
  source text NOT NULL CHECK (source IN ('native','mlflow','sync')),
  actor_user_id uuid REFERENCES users(id),
  actor_token_id uuid REFERENCES api_tokens(id),
  reason text CHECK (length(reason) <= 2000),
  CHECK (actor_token_id IS NULL OR actor_user_id IS NOT NULL),
  FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id)
);
CREATE INDEX run_resume_events_run ON run_resume_events(run_id,resumed_at,id);

CREATE FUNCTION reject_run_resume_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Run resume events are append-only' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER run_resume_events_append_only BEFORE UPDATE OR DELETE ON run_resume_events
  FOR EACH ROW EXECUTE FUNCTION reject_run_resume_event_change();

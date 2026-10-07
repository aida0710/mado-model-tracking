-- A repeated retry request returns the same new Run/Job instead of executing twice.
ALTER TABLE jobs ADD COLUMN retry_of_job_id uuid UNIQUE REFERENCES jobs(id);
CREATE TABLE demo_seed_history (
  name text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  completed_at timestamptz NOT NULL DEFAULT now()
);

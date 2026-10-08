-- Short-lived credentials handed to the code a Job runs, instead of the worker's own token.
-- A token is valid only while its Job still holds the lease it was issued for; there is no
-- expiry column because the lease, not the clock, bounds its lifetime.
CREATE TABLE job_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  job_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  run_id uuid NOT NULL,
  -- The Run's creator: the code runs with that person's current Project role.
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (job_id,project_id) REFERENCES jobs(id,project_id),
  FOREIGN KEY (run_id,project_id) REFERENCES runs(id,project_id)
);
CREATE INDEX job_tokens_job ON job_tokens(job_id);

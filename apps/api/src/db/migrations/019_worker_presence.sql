-- One row per worker process identity. A worker id is chosen by the worker host, so it is
-- only unique within the token that authenticates it.
CREATE TABLE workers (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_id uuid NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  version text,
  hostname text,
  target_ids uuid[],
  parallel_jobs integer CHECK (parallel_jobs IS NULL OR parallel_jobs > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, worker_id)
);
CREATE INDEX workers_project_last_seen ON workers(project_id, last_seen_at);

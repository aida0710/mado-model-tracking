CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oidc_states (
  state_hash text PRIMARY KEY,
  binding_hash text NOT NULL,
  verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  artifact_backend text NOT NULL DEFAULT 'filesystem' CHECK (artifact_backend IN ('filesystem','s3')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('viewer','editor','admin')),
  PRIMARY KEY (project_id,user_id)
);
CREATE INDEX project_members_user ON project_members(user_id);
CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid REFERENCES projects(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal','service')),
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'service' OR project_id IS NOT NULL),
  CHECK (NOT ('worker:execute' = ANY(scopes)) OR project_id IS NOT NULL)
);
CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,project_id), UNIQUE(project_id,name)
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  run_id uuid,
  path text NOT NULL,
  backend text NOT NULL CHECK (backend IN ('filesystem','s3')),
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size bigint NOT NULL CHECK(size >= 0),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id)
);
CREATE TABLE codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id), UNIQUE(project_id,name)
);
CREATE TABLE code_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version text NOT NULL,
  source jsonb NOT NULL,
  entrypoint text[] NOT NULL,
  requirements text[] NOT NULL DEFAULT '{}',
  environment jsonb NOT NULL DEFAULT '{}',
  supported_model_families text[] NOT NULL,
  task_types text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id), UNIQUE(code_id,version),
  FOREIGN KEY(code_id,project_id) REFERENCES codes(id,project_id)
);
CREATE TABLE models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  family text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id), UNIQUE(project_id,name)
);
CREATE TABLE model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version text NOT NULL,
  source_run_id uuid,
  parent_model_version_ids uuid[] NOT NULL DEFAULT '{}',
  weights_uri text,
  artifact_id uuid,
  default_code_version_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id), UNIQUE(id,model_id), UNIQUE(model_id,version),
  FOREIGN KEY(model_id,project_id) REFERENCES models(id,project_id),
  FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id),
  FOREIGN KEY(default_code_version_id,project_id) REFERENCES code_versions(id,project_id)
);
CREATE TABLE model_aliases (
  model_id uuid NOT NULL REFERENCES models(id),
  alias text NOT NULL,
  version_id uuid NOT NULL,
  PRIMARY KEY(model_id,alias),
  FOREIGN KEY(version_id,model_id) REFERENCES model_versions(id,model_id)
);
CREATE TABLE datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  namespace text NOT NULL DEFAULT 'local',
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id), UNIQUE(project_id,namespace,name)
);
CREATE TABLE dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version text NOT NULL,
  uri text NOT NULL,
  digest text NOT NULL,
  schema jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  source_run_id uuid,
  parent_dataset_version_ids uuid[] NOT NULL DEFAULT '{}',
  external_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id), UNIQUE(dataset_id,version),
  FOREIGN KEY(dataset_id,project_id) REFERENCES datasets(id,project_id)
);
CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  experiment_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('inference','evaluation','training','finetuning','processing')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','finished','failed','canceled')),
  parameters jsonb NOT NULL DEFAULT '{}',
  tags jsonb NOT NULL DEFAULT '{}',
  latest_metrics jsonb NOT NULL DEFAULT '{}',
  model_version_id uuid,
  code_version_id uuid,
  input_dataset_version_ids uuid[] NOT NULL DEFAULT '{}',
  output_dataset_version_ids uuid[] NOT NULL DEFAULT '{}',
  parent_run_id uuid,
  environment jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  error text,
  UNIQUE(id,project_id),
  FOREIGN KEY(experiment_id,project_id) REFERENCES experiments(id,project_id),
  FOREIGN KEY(model_version_id,project_id) REFERENCES model_versions(id,project_id),
  FOREIGN KEY(code_version_id,project_id) REFERENCES code_versions(id,project_id),
  FOREIGN KEY(parent_run_id,project_id) REFERENCES runs(id,project_id)
);
ALTER TABLE artifacts ADD FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id);
ALTER TABLE model_versions ADD FOREIGN KEY(source_run_id,project_id) REFERENCES runs(id,project_id);
ALTER TABLE dataset_versions ADD FOREIGN KEY(source_run_id,project_id) REFERENCES runs(id,project_id);
CREATE INDEX runs_project_created ON runs(project_id,created_at DESC);
CREATE TABLE metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  name text NOT NULL,
  value double precision NOT NULL,
  step bigint NOT NULL,
  timestamp timestamptz NOT NULL
);
CREATE INDEX metrics_run ON metrics(run_id,name,step,timestamp);
CREATE TABLE run_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  timestamp timestamptz NOT NULL,
  level text NOT NULL CHECK(level IN ('info','warning','error')),
  message text NOT NULL
);
CREATE INDEX logs_run ON run_logs(run_id,id);
CREATE TABLE compute_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  host text NOT NULL,
  port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
  username text NOT NULL,
  ssh_key_path text NOT NULL,
  known_hosts_path text NOT NULL,
  work_directory text NOT NULL,
  python_executable text NOT NULL,
  gpu_ids text[] NOT NULL DEFAULT '{}',
  max_concurrent_jobs integer NOT NULL CHECK(max_concurrent_jobs BETWEEN 1 AND 128),
  enabled boolean NOT NULL DEFAULT true,
  executor text NOT NULL CHECK(executor IN ('ssh','local'))
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  run_id uuid NOT NULL UNIQUE,
  target_id uuid NOT NULL REFERENCES compute_targets(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','running','finished','failed','canceled')),
  gpu_ids text[] NOT NULL DEFAULT '{}',
  worker_id text,
  lease_id uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  heartbeat_at timestamptz,
  exit_code integer,
  error text,
  worker_token_id uuid REFERENCES api_tokens(id),
  FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id)
);
CREATE INDEX jobs_queue ON jobs(project_id,created_at) WHERE status = 'queued';
CREATE INDEX jobs_active_target ON jobs(target_id) WHERE status IN ('claimed','running');
CREATE INDEX jobs_worker ON jobs(worker_token_id,worker_id) WHERE status IN ('claimed','running');
CREATE TABLE gpu_reservations (
  target_id uuid NOT NULL REFERENCES compute_targets(id),
  gpu_id text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  PRIMARY KEY(target_id,gpu_id), UNIQUE(job_id,gpu_id)
);
CREATE TABLE plugin_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  base_url text NOT NULL,
  token_env text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  manifest jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id), UNIQUE(project_id,name)
);
CREATE TABLE plugin_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id uuid NOT NULL REFERENCES plugin_connections(id),
  event_id uuid NOT NULL,
  event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','delivered')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivery_id uuid,
  locked_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plugin_id,event_id)
);
CREATE INDEX plugin_outbox_pending ON plugin_outbox(next_attempt_at) WHERE status <> 'delivered';

CREATE FUNCTION reject_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Registry versions are immutable' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER code_versions_immutable BEFORE UPDATE ON code_versions FOR EACH ROW EXECUTE FUNCTION reject_version_update();
CREATE TRIGGER model_versions_immutable BEFORE UPDATE ON model_versions FOR EACH ROW EXECUTE FUNCTION reject_version_update();
CREATE TRIGGER dataset_versions_immutable BEFORE UPDATE ON dataset_versions FOR EACH ROW EXECUTE FUNCTION reject_version_update();

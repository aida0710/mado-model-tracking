CREATE TABLE mlflow_logged_models (
  id text PRIMARY KEY CHECK(id ~ '^m-[a-f0-9]{32}$'),
  project_id uuid NOT NULL REFERENCES projects(id),
  experiment_id uuid NOT NULL,
  source_run_id uuid,
  name text NOT NULL,
  model_type text,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','READY','FAILED')),
  params jsonb NOT NULL DEFAULT '{}',
  tags jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id,project_id),
  FOREIGN KEY(experiment_id,project_id) REFERENCES experiments(id,project_id),
  FOREIGN KEY(source_run_id,project_id) REFERENCES runs(id,project_id)
);
CREATE INDEX mlflow_logged_models_search ON mlflow_logged_models(project_id,experiment_id,created_at DESC,id);

CREATE TABLE mlflow_logged_model_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id text NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  key text NOT NULL,
  value double precision NOT NULL,
  timestamp_ms bigint NOT NULL,
  step bigint NOT NULL,
  dataset_name text,
  dataset_digest text,
  FOREIGN KEY(model_id,project_id) REFERENCES mlflow_logged_models(id,project_id),
  FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),
  CHECK(dataset_digest IS NULL OR dataset_name IS NOT NULL)
);
CREATE UNIQUE INDEX mlflow_logged_model_metrics_point ON mlflow_logged_model_metrics(
  model_id,run_id,key,timestamp_ms,step,COALESCE(dataset_name,''),COALESCE(dataset_digest,'')
);
CREATE INDEX mlflow_logged_model_metrics_latest ON mlflow_logged_model_metrics(model_id,key,step DESC,timestamp_ms DESC,id DESC);

CREATE TABLE mlflow_registered_model_metadata (
  model_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  tags jsonb NOT NULL DEFAULT '{}',
  next_version bigint NOT NULL DEFAULT 1 CHECK(next_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY(model_id,project_id) REFERENCES models(id,project_id)
);

CREATE TABLE mlflow_model_version_metadata (
  version_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  logged_model_id text,
  artifact_uri text NOT NULL,
  tags jsonb NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  run_link text NOT NULL DEFAULT '',
  current_stage text NOT NULL DEFAULT 'None' CHECK(current_stage IN ('None','Staging','Production','Archived')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY(version_id,project_id) REFERENCES model_versions(id,project_id),
  FOREIGN KEY(logged_model_id,project_id) REFERENCES mlflow_logged_models(id,project_id)
);
CREATE INDEX mlflow_model_version_logged_model ON mlflow_model_version_metadata(logged_model_id);

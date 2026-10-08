ALTER TABLE experiments
  ADD COLUMN lifecycle_stage text NOT NULL DEFAULT 'active' CHECK (lifecycle_stage IN ('active','deleted')),
  ADD COLUMN tags jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN artifact_location text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE runs
  ADD COLUMN lifecycle_stage text NOT NULL DEFAULT 'active' CHECK (lifecycle_stage IN ('active','deleted')),
  ADD COLUMN mlflow_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN mlflow_user_id text,
  ADD COLUMN recorded_parameters jsonb NOT NULL DEFAULT '{}';

-- Context is part of a metric point's identity in MLflow 3, including model evaluation.
ALTER TABLE metrics
  ADD COLUMN mlflow_logged boolean NOT NULL DEFAULT false,
  ADD COLUMN mlflow_model_id text,
  ADD COLUMN mlflow_dataset_name text,
  ADD COLUMN mlflow_dataset_digest text;
CREATE UNIQUE INDEX metrics_mlflow_retry ON metrics
  (run_id,name,step,timestamp,value,mlflow_model_id,mlflow_dataset_name,mlflow_dataset_digest)
  NULLS NOT DISTINCT WHERE mlflow_logged;

CREATE TABLE mlflow_datasets (
  project_id uuid NOT NULL REFERENCES projects(id),
  identity text NOT NULL,
  dataset_version_id uuid NOT NULL,
  dataset jsonb NOT NULL,
  PRIMARY KEY (project_id,identity),
  UNIQUE (project_id,dataset_version_id),
  FOREIGN KEY (dataset_version_id,project_id) REFERENCES dataset_versions(id,project_id)
);
CREATE TABLE mlflow_run_dataset_inputs (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  context text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id,run_id,dataset_version_id,context),
  FOREIGN KEY (run_id,project_id) REFERENCES runs(id,project_id),
  FOREIGN KEY (dataset_version_id,project_id) REFERENCES dataset_versions(id,project_id)
);
-- Logged Models are introduced in 006; their Project reference is checked by the service.
CREATE TABLE mlflow_run_model_inputs (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  model_id text NOT NULL,
  PRIMARY KEY (project_id,run_id,model_id),
  FOREIGN KEY (run_id,project_id) REFERENCES runs(id,project_id)
);
CREATE TABLE mlflow_run_model_outputs (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  model_id text NOT NULL,
  step bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id,run_id,model_id,step),
  FOREIGN KEY (run_id,project_id) REFERENCES runs(id,project_id)
);
CREATE INDEX mlflow_experiments_lifecycle ON experiments(project_id,lifecycle_stage,created_at);
CREATE INDEX mlflow_runs_lifecycle ON runs(project_id,experiment_id,lifecycle_stage,created_at);

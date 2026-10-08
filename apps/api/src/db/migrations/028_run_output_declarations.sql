-- Outputs a container declared in result.json version 2 and the worker registered through
-- POST /worker/jobs/:id/outputs. The primary key makes a resent declaration (the worker retries
-- after a lost response or a restart) return the stored version instead of registering again.
CREATE TABLE run_output_declarations (
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  declaration_index integer NOT NULL CHECK (declaration_index >= 0),
  kind text NOT NULL CHECK (kind IN ('model','dataset')),
  model_version_id uuid,
  dataset_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,declaration_index),
  FOREIGN KEY (run_id,project_id) REFERENCES runs(id,project_id),
  FOREIGN KEY (model_version_id,project_id) REFERENCES model_versions(id,project_id),
  FOREIGN KEY (dataset_version_id,project_id) REFERENCES dataset_versions(id,project_id),
  CHECK (
    (kind='model' AND model_version_id IS NOT NULL AND dataset_version_id IS NULL)
    OR (kind='dataset' AND dataset_version_id IS NOT NULL AND model_version_id IS NULL)
  )
);
CREATE TRIGGER run_output_declarations_immutable BEFORE UPDATE ON run_output_declarations
  FOR EACH ROW EXECUTE FUNCTION reject_version_update();

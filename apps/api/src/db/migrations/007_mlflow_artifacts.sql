CREATE TABLE mlflow_artifact_paths (
  project_id uuid NOT NULL REFERENCES projects(id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('run','model')),
  owner_id text NOT NULL,
  path text NOT NULL CHECK (octet_length(path) BETWEEN 1 AND 1024),
  artifact_id uuid NOT NULL,
  PRIMARY KEY(project_id,owner_kind,owner_id,path),
  FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id)
);
CREATE INDEX mlflow_artifact_paths_artifact ON mlflow_artifact_paths(artifact_id,project_id);

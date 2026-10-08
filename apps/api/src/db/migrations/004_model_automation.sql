CREATE TABLE model_automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  model_families text[] NOT NULL CHECK(cardinality(model_families) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK(kind IN ('inference','evaluation')),
  experiment_id uuid NOT NULL,
  code_version_id uuid NOT NULL,
  target_id uuid NOT NULL REFERENCES compute_targets(id),
  gpu_ids text[] NOT NULL DEFAULT '{}',
  input_dataset_version_ids uuid[] NOT NULL DEFAULT '{}',
  parameters jsonb NOT NULL DEFAULT '{}',
  tags jsonb NOT NULL DEFAULT '{}',
  max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,project_id),
  FOREIGN KEY(experiment_id,project_id) REFERENCES experiments(id,project_id),
  FOREIGN KEY(code_version_id,project_id) REFERENCES code_versions(id,project_id)
);
CREATE INDEX model_automation_rules_project ON model_automation_rules(project_id,created_at DESC);

CREATE FUNCTION reject_automation_rule_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled') THEN
    RAISE EXCEPTION 'Automation rule configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER automation_rules_immutable BEFORE UPDATE ON model_automation_rules FOR EACH ROW EXECUTE FUNCTION reject_automation_rule_update();

-- The event marker also covers registration with no rules, so enabling or creating a rule never replays history.
CREATE TABLE model_automation_events (
  model_version_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(model_version_id,project_id) REFERENCES model_versions(id,project_id)
);
INSERT INTO model_automation_events(model_version_id,project_id) SELECT id,project_id FROM model_versions;

ALTER TABLE jobs ADD CONSTRAINT jobs_id_project_unique UNIQUE(id,project_id);
CREATE TABLE model_automation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  rule_id uuid NOT NULL,
  model_version_id uuid NOT NULL,
  run_id uuid,
  job_id uuid,
  status text NOT NULL CHECK(status IN ('queued','failed','skipped')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rule_id,model_version_id),
  FOREIGN KEY(rule_id,project_id) REFERENCES model_automation_rules(id,project_id),
  FOREIGN KEY(model_version_id,project_id) REFERENCES model_versions(id,project_id),
  FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),
  FOREIGN KEY(job_id,project_id) REFERENCES jobs(id,project_id),
  CHECK (
    (status='queued' AND run_id IS NOT NULL AND job_id IS NOT NULL AND error IS NULL)
    OR (status IN ('failed','skipped') AND run_id IS NULL AND job_id IS NULL AND error IS NOT NULL)
  )
);
CREATE INDEX model_automation_executions_project ON model_automation_executions(project_id,created_at DESC,id DESC);

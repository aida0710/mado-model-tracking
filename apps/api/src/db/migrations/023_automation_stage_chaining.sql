-- Rules can start from another rule's finished Run instead of a model registration, which chains
-- inference → evaluation (or longer pipelines) without a separate pipeline entity.
ALTER TABLE model_automation_rules
  ADD COLUMN trigger text NOT NULL DEFAULT 'model_registered'
    CHECK (trigger IN ('model_registered','upstream_run_finished')),
  ADD COLUMN upstream_rule_id uuid,
  ADD CONSTRAINT model_automation_rules_upstream
    FOREIGN KEY (upstream_rule_id, project_id) REFERENCES model_automation_rules(id, project_id),
  ADD CONSTRAINT model_automation_rules_upstream_trigger
    CHECK ((trigger = 'upstream_run_finished') = (upstream_rule_id IS NOT NULL));
ALTER TABLE model_automation_rules DROP CONSTRAINT model_automation_rules_kind_check;
ALTER TABLE model_automation_rules ADD CONSTRAINT model_automation_rules_kind_check
  CHECK (kind IN ('inference','evaluation','processing'));
-- reject_automation_rule_update compares the whole row except enabled, so trigger and
-- upstream_rule_id are immutable without changing the trigger function.
CREATE INDEX model_automation_rules_downstream ON model_automation_rules(upstream_rule_id)
  WHERE upstream_rule_id IS NOT NULL;

-- Each stored execution names the upstream Run that started it (null for the first stage), the
-- first-stage execution of its pipeline (itself for the first stage), and whether a person
-- applied it by hand. attempt lets the same rule run again for one version without a new rule.
ALTER TABLE model_automation_executions
  ADD COLUMN trigger_run_id uuid,
  ADD COLUMN pipeline_root_execution_id uuid,
  ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  ADD COLUMN source text NOT NULL DEFAULT 'automatic' CHECK (source IN ('automatic','manual')),
  ADD COLUMN requested_by uuid REFERENCES users(id),
  ADD CONSTRAINT model_automation_executions_trigger_run
    FOREIGN KEY (trigger_run_id, project_id) REFERENCES runs(id, project_id),
  ADD CONSTRAINT model_automation_executions_manual_requester
    CHECK ((source = 'manual') = (requested_by IS NOT NULL)),
  ADD CONSTRAINT model_automation_executions_id_project UNIQUE (id, project_id);
UPDATE model_automation_executions SET pipeline_root_execution_id = id;
-- A first stage is its own pipeline root; filling it here keeps every writer (and existing
-- inserts that predate chaining) from having to know its own generated id.
CREATE FUNCTION default_pipeline_root_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.pipeline_root_execution_id := COALESCE(NEW.pipeline_root_execution_id, NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_automation_executions_pipeline_root BEFORE INSERT ON model_automation_executions
  FOR EACH ROW EXECUTE FUNCTION default_pipeline_root_execution();
ALTER TABLE model_automation_executions
  ALTER COLUMN pipeline_root_execution_id SET NOT NULL,
  ADD CONSTRAINT model_automation_executions_pipeline_root
    FOREIGN KEY (pipeline_root_execution_id, project_id)
    REFERENCES model_automation_executions(id, project_id);

-- Only the automatic run of a registration stays once per (rule, version); manual applications and
-- later attempts add rows. Registration-triggered executions are the ones without a trigger Run.
ALTER TABLE model_automation_executions
  DROP CONSTRAINT model_automation_executions_rule_id_model_version_id_key;
CREATE UNIQUE INDEX model_automation_executions_registration_once
  ON model_automation_executions(rule_id, model_version_id, attempt)
  WHERE trigger_run_id IS NULL AND source = 'automatic';
ALTER TABLE model_automation_executions
  ADD CONSTRAINT model_automation_executions_trigger_once UNIQUE (rule_id, trigger_run_id, attempt);
CREATE INDEX model_automation_executions_rule_version
  ON model_automation_executions(rule_id, model_version_id, attempt DESC);
-- The chain handler and promotion find the execution that created a finished Run.
CREATE INDEX model_automation_executions_run ON model_automation_executions(run_id)
  WHERE run_id IS NOT NULL;

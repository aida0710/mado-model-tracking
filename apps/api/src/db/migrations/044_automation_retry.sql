-- Automatic retry: a failed automated Run gets a next attempt as a new execution that points at
-- the one it retries. The unique index keeps a repeated completion from retrying twice.
ALTER TABLE model_automation_executions
  ADD COLUMN retry_of_execution_id uuid,
  ADD CONSTRAINT model_automation_executions_retry_of
    FOREIGN KEY (retry_of_execution_id, project_id)
    REFERENCES model_automation_executions(id, project_id);
CREATE UNIQUE INDEX model_automation_executions_retry_once
  ON model_automation_executions(retry_of_execution_id)
  WHERE retry_of_execution_id IS NOT NULL;

-- The owner a rule runs as. created_by stays the record of who made the rule; a Project admin
-- may move run_as_user_id to a Service Account so the rule survives its creator leaving.
-- The rule configuration stays immutable apart from enabled and the owner.
CREATE OR REPLACE FUNCTION reject_automation_rule_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'enabled'-'run_as_user_id') IS DISTINCT FROM (to_jsonb(OLD)-'enabled'-'run_as_user_id') THEN
    RAISE EXCEPTION 'Automation rule configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE model_automation_rules ADD COLUMN run_as_user_id uuid REFERENCES users(id);
UPDATE model_automation_rules SET run_as_user_id = created_by;
ALTER TABLE model_automation_rules ALTER COLUMN run_as_user_id SET NOT NULL;
-- A new rule runs as its creator; writers that predate the owner need not name it.
CREATE FUNCTION default_automation_rule_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.run_as_user_id := COALESCE(NEW.run_as_user_id, NEW.created_by);
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_automation_rules_default_owner BEFORE INSERT ON model_automation_rules
  FOR EACH ROW EXECUTE FUNCTION default_automation_rule_owner();

-- A promotion policy judges evaluation Runs that one evaluation automation rule produced.
-- The reference set and evaluation CodeVersion are not stored here: they are the rule's fixed
-- input_dataset_version_ids and code_version_id, and the rule itself is immutable.
-- auto_promote is only stored for now; switching the alias on a pass comes in a later wave.
CREATE TABLE model_promotion_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  model_id uuid NOT NULL,
  target_alias text NOT NULL CHECK (length(target_alias) BETWEEN 1 AND 200),
  baseline_alias text NOT NULL CHECK (length(baseline_alias) BETWEEN 1 AND 200),
  evaluation_rule_id uuid NOT NULL,
  criteria jsonb NOT NULL CHECK (
    jsonb_typeof(criteria) = 'array' AND jsonb_array_length(criteria) BETWEEN 1 AND 50),
  missing_baseline text NOT NULL DEFAULT 'pass' CHECK (missing_baseline IN ('pass','fail')),
  auto_promote boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id),
  FOREIGN KEY (model_id, project_id) REFERENCES models(id, project_id),
  FOREIGN KEY (evaluation_rule_id, project_id) REFERENCES model_automation_rules(id, project_id)
);
CREATE INDEX model_promotion_policies_project ON model_promotion_policies(project_id, created_at DESC, id DESC);
-- The terminal handler looks policies up by the evaluation Run's rule and model.
CREATE INDEX model_promotion_policies_rule ON model_promotion_policies(evaluation_rule_id, model_id) WHERE enabled;

-- Like automation rules, a policy's settings are fixed once created; only enabled may change.
-- Changing the criteria means creating a new policy, so past decisions keep their meaning.
CREATE FUNCTION reject_promotion_policy_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled') THEN
    RAISE EXCEPTION 'Promotion policy configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_promotion_policies_immutable BEFORE UPDATE ON model_promotion_policies
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_policy_update();

-- One decision of a policy about one candidate evaluation Run. Append-only: a re-evaluation is a
-- new row with sequence + 1 for the same (policy, candidate Run). requested_by is NULL for the
-- automatic decision made when the evaluation Run finished.
CREATE TABLE model_promotion_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  policy_id uuid NOT NULL,
  candidate_version_id uuid NOT NULL,
  candidate_run_id uuid NOT NULL,
  baseline_version_id uuid,
  baseline_run_id uuid,
  decision text NOT NULL CHECK (decision IN ('passed','failed','insufficient','skipped')),
  criteria_results jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(criteria_results) = 'array'),
  reason text CHECK (length(reason) <= 200),
  promoted boolean NOT NULL DEFAULT false,
  alias_event_id uuid REFERENCES model_alias_events(id),
  sequence integer NOT NULL DEFAULT 1 CHECK (sequence >= 1),
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, candidate_run_id, sequence),
  FOREIGN KEY (policy_id, project_id) REFERENCES model_promotion_policies(id, project_id),
  FOREIGN KEY (candidate_version_id, project_id) REFERENCES model_versions(id, project_id),
  FOREIGN KEY (candidate_run_id, project_id) REFERENCES runs(id, project_id),
  FOREIGN KEY (baseline_version_id, project_id) REFERENCES model_versions(id, project_id),
  FOREIGN KEY (baseline_run_id, project_id) REFERENCES runs(id, project_id)
);
CREATE INDEX model_promotion_evaluations_project ON model_promotion_evaluations(project_id, created_at DESC, id DESC);
CREATE INDEX model_promotion_evaluations_policy ON model_promotion_evaluations(policy_id, created_at DESC, id DESC);
CREATE INDEX model_promotion_evaluations_candidate ON model_promotion_evaluations(candidate_version_id, created_at DESC, id DESC);

CREATE FUNCTION reject_promotion_evaluation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Promotion evaluations are append-only' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER model_promotion_evaluations_append_only BEFORE UPDATE OR DELETE ON model_promotion_evaluations
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_evaluation_change();

-- 016 left the column without a target because this table did not exist yet. Deferred so that an
-- automatic promotion can write the alias event and the (append-only) evaluation that points at
-- it in one transaction without updating either row.
ALTER TABLE model_alias_events
  ADD CONSTRAINT model_alias_events_promotion_evaluation
  FOREIGN KEY (promotion_evaluation_id) REFERENCES model_promotion_evaluations(id)
  DEFERRABLE INITIALLY DEFERRED;

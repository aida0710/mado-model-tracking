-- A promotion policy acts as run_as_user_id: its current authority is re-checked at every
-- judgement, and an automatic promotion records it as the alias change's actor. created_by stays
-- the record of who created the policy. Moving run_as_user_id to a Service Account keeps the policy
-- working after its human creator leaves.
ALTER TABLE model_promotion_policies ADD COLUMN run_as_user_id uuid REFERENCES users(id);

-- The settings stay immutable; the owner is the one more column that may change besides enabled.
CREATE OR REPLACE FUNCTION reject_promotion_policy_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'enabled' - 'run_as_user_id')
    IS DISTINCT FROM (to_jsonb(OLD) - 'enabled' - 'run_as_user_id') THEN
    RAISE EXCEPTION 'Promotion policy configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

UPDATE model_promotion_policies SET run_as_user_id=created_by;
ALTER TABLE model_promotion_policies ALTER COLUMN run_as_user_id SET NOT NULL;

-- A protected alias can be changed by hand only by a user whose current effective role reaches
-- required_role, and, with require_passed_evaluation, only toward a version backed by a passed
-- promotion decision for that alias. model_id NULL protects the alias on every Model of the
-- Project. When both a Project-wide and a Model row match, the stricter of each setting applies.
CREATE TABLE model_alias_protections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  model_id uuid,
  alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 200),
  required_role text NOT NULL CHECK (required_role IN ('editor','admin')),
  require_passed_evaluation boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (model_id, project_id) REFERENCES models(id, project_id)
);
CREATE UNIQUE INDEX model_alias_protections_project_alias
  ON model_alias_protections(project_id, alias) WHERE model_id IS NULL;
CREATE UNIQUE INDEX model_alias_protections_model_alias
  ON model_alias_protections(model_id, alias) WHERE model_id IS NOT NULL;

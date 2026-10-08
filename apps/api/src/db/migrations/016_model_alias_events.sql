-- model_aliases keeps only the current value; every change is appended here so
-- "who moved which alias, from which version, and why" survives later changes.
-- version_id NULL records a removal. actor_user_id is NULL only for rows written
-- without a principal (the migration snapshot below and system-driven changes).
-- promotion_evaluation_id gets its foreign key when promotion evaluations exist.
CREATE TABLE model_alias_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  model_id uuid NOT NULL,
  alias text NOT NULL,
  previous_version_id uuid,
  version_id uuid,
  source text NOT NULL CHECK (source IN ('web','api','mlflow','promotion_policy','version_deleted','model_deleted')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
  promotion_evaluation_id uuid,
  actor_user_id uuid REFERENCES users(id),
  actor_token_id uuid REFERENCES api_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_version_id IS NOT NULL OR version_id IS NOT NULL),
  CHECK (actor_token_id IS NULL OR actor_user_id IS NOT NULL),
  FOREIGN KEY(model_id,project_id) REFERENCES models(id,project_id),
  FOREIGN KEY(version_id,model_id) REFERENCES model_versions(id,model_id),
  FOREIGN KEY(previous_version_id,model_id) REFERENCES model_versions(id,model_id)
);
CREATE INDEX model_alias_events_model ON model_alias_events(model_id,alias,created_at DESC,id DESC);
CREATE INDEX model_alias_events_project ON model_alias_events(project_id,created_at DESC);

CREATE FUNCTION reject_model_alias_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Model alias events are append-only' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER model_alias_events_append_only BEFORE UPDATE OR DELETE ON model_alias_events
  FOR EACH ROW EXECUTE FUNCTION reject_model_alias_event_change();

-- Aliases set before this migration have no recorded history; start each one from a snapshot.
INSERT INTO model_alias_events(project_id,model_id,alias,version_id,source,reason)
SELECT m.project_id,a.model_id,a.alias,a.version_id,'api','migration snapshot'
FROM model_aliases a JOIN models m ON m.id=a.model_id;

ALTER TABLE code_versions ALTER COLUMN source DROP NOT NULL;
ALTER TABLE code_versions ADD COLUMN runtime jsonb NOT NULL DEFAULT '{"kind":"python"}';
ALTER TABLE code_versions ADD CONSTRAINT code_runtime_kind CHECK (
  jsonb_typeof(runtime)='object' AND COALESCE(runtime->>'kind' IN ('python','docker','singularity','apptainer'),false)
);
ALTER TABLE code_versions ADD CONSTRAINT code_runtime_source CHECK (
  runtime->>'kind'<>'python' OR (source IS NOT NULL AND source<>'null'::jsonb)
);
ALTER TABLE code_versions ADD CONSTRAINT code_runtime_requirements CHECK (
  runtime->>'kind'='python' OR cardinality(requirements)=0
);
ALTER TABLE compute_targets ADD COLUMN runtime_kinds text[] NOT NULL DEFAULT '{python}';
ALTER TABLE compute_targets ADD CONSTRAINT target_runtime_kinds CHECK (
  cardinality(runtime_kinds) BETWEEN 1 AND 4 AND runtime_kinds <@ ARRAY['python','docker','singularity','apptainer']::text[]
);

UPDATE runs r SET environment=jsonb_set(r.environment,'{runtime}',c.runtime,true)
FROM code_versions c WHERE c.id=r.code_version_id AND c.project_id=r.project_id;

CREATE FUNCTION reject_run_runtime_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.code_version_id IS DISTINCT FROM NEW.code_version_id
    OR (OLD.code_version_id IS NOT NULL AND OLD.environment->'runtime' IS DISTINCT FROM NEW.environment->'runtime') THEN
    RAISE EXCEPTION 'Run runtime and code version are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runs_runtime_immutable BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION reject_run_runtime_update();

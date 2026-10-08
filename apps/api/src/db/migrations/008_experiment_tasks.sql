ALTER TABLE code_versions ADD COLUMN test_entrypoint text[] NOT NULL DEFAULT '{}';
ALTER TABLE code_versions ADD CONSTRAINT code_test_entrypoint_size CHECK (cardinality(test_entrypoint)<=100);

CREATE TABLE experiment_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  experiment_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('inference','evaluation','training','finetuning','processing')),
  code_version_id uuid NOT NULL,
  model_version_id uuid,
  input_dataset_version_ids uuid[] NOT NULL DEFAULT '{}',
  parameters jsonb NOT NULL DEFAULT '{}',
  tags jsonb NOT NULL DEFAULT '{}',
  target_id uuid REFERENCES compute_targets(id),
  gpu_ids text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,project_id),
  FOREIGN KEY (experiment_id,project_id) REFERENCES experiments(id,project_id),
  FOREIGN KEY (code_version_id,project_id) REFERENCES code_versions(id,project_id),
  FOREIGN KEY (model_version_id,project_id) REFERENCES model_versions(id,project_id),
  CHECK (jsonb_typeof(parameters)='object' AND jsonb_typeof(tags)='object')
);
CREATE INDEX experiment_tasks_project ON experiment_tasks(project_id,experiment_id,created_at DESC,id DESC);

CREATE FUNCTION guard_task_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'Task identity is immutable and saves must increment revision' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER experiment_tasks_revision BEFORE UPDATE ON experiment_tasks FOR EACH ROW EXECUTE FUNCTION guard_task_revision();

ALTER TABLE runs
  ADD COLUMN task_id uuid,
  ADD COLUMN task_revision integer,
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'run' CHECK (execution_mode IN ('run','test')),
  ADD COLUMN execution_snapshot jsonb,
  ADD FOREIGN KEY (task_id,project_id) REFERENCES experiment_tasks(id,project_id),
  ADD CONSTRAINT run_task_revision CHECK (
    (task_id IS NULL AND task_revision IS NULL) OR (task_id IS NOT NULL AND task_revision IS NOT NULL AND task_revision>0)
  );
CREATE INDEX runs_task_history ON runs(project_id,task_id,created_at DESC,id DESC) WHERE task_id IS NOT NULL;

CREATE FUNCTION build_run_execution_snapshot(code code_versions, mode text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'codeVersionId',code.id,'version',code.version,'mode',mode,'source',code.source,
    'runtime',code.runtime,'entrypoint',CASE WHEN mode='test' THEN code.test_entrypoint ELSE code.entrypoint END,
    'requirements',code.requirements,'environment',code.environment
  );
$$;
UPDATE runs r SET execution_snapshot=build_run_execution_snapshot(c,'run')
FROM code_versions c WHERE c.id=r.code_version_id AND c.project_id=r.project_id;

ALTER TABLE runs ADD CONSTRAINT run_execution_snapshot_required CHECK (
  (code_version_id IS NULL AND execution_snapshot IS NULL AND execution_mode='run')
  OR (code_version_id IS NOT NULL AND execution_snapshot IS NOT NULL AND jsonb_typeof(execution_snapshot)='object')
);

CREATE FUNCTION guard_run_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  code code_versions;
  snapshot jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.execution_mode IS DISTINCT FROM OLD.execution_mode OR NEW.execution_snapshot IS DISTINCT FROM OLD.execution_snapshot
      OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.task_revision IS DISTINCT FROM OLD.task_revision THEN
      RAISE EXCEPTION 'Run execution snapshot and task revision are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.code_version_id IS NULL THEN
    IF NEW.execution_mode<>'run' OR NEW.execution_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'Execution requires a fixed code version' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO code FROM code_versions WHERE id=NEW.code_version_id AND project_id=NEW.project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Code version does not belong to project' USING ERRCODE='23503'; END IF;
  IF NEW.execution_mode='test' AND cardinality(code.test_entrypoint)=0 THEN
    RAISE EXCEPTION 'Test command is required' USING ERRCODE='23514';
  END IF;
  snapshot=build_run_execution_snapshot(code,NEW.execution_mode);
  IF NEW.execution_snapshot IS NOT NULL AND NEW.execution_snapshot IS DISTINCT FROM snapshot THEN
    RAISE EXCEPTION 'Execution snapshot does not match code version' USING ERRCODE='23514';
  END IF;
  NEW.execution_snapshot=snapshot;
  NEW.environment=jsonb_set(NEW.environment,'{runtime}',code.runtime,true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER runs_execution_snapshot BEFORE INSERT OR UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION guard_run_execution_snapshot();

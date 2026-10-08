// Output models are derived from model_versions.source_run_id so deleting a version needs no
// second write; MLflow soft-deleted versions (including deleted registered models) are excluded.
export const outputModelVersionIdsColumn = `ARRAY(
  SELECT v.id FROM model_versions v
  LEFT JOIN mlflow_model_version_metadata vm ON vm.version_id=v.id
  WHERE v.project_id=runs.project_id AND v.source_run_id=runs.id AND vm.deleted_at IS NULL
  ORDER BY v.created_at,v.id) AS output_model_version_ids`;

// Every statement that returns a whole Run (SELECT or RETURNING) uses this so the field is never missing.
export const runColumns = `*,${outputModelVersionIdsColumn}`;

// Polling lists retain execution identity; code text and code environment belong to detail reads.
export const runSummarySelect = `SELECT
  id,project_id,experiment_id,name,kind,status,parameters,tags,latest_metrics,
  model_version_id,code_version_id,input_dataset_version_ids,upstream_dataset_version_ids,
  output_dataset_version_ids,
  ${outputModelVersionIdsColumn},
  parent_run_id,environment,created_by,created_at,started_at,ended_at,error,
  lifecycle_stage,mlflow_managed,mlflow_user_id,recorded_parameters,
  task_id,task_revision,execution_mode,resume_checkpoint_id
  FROM runs`;

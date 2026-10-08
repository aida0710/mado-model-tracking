// Polling lists retain execution identity; code text and code environment belong to detail reads.
export const runSummarySelect = `SELECT
  id,project_id,experiment_id,name,kind,status,parameters,tags,latest_metrics,
  model_version_id,code_version_id,input_dataset_version_ids,output_dataset_version_ids,
  parent_run_id,environment,created_by,created_at,started_at,ended_at,error,
  lifecycle_stage,mlflow_managed,mlflow_user_id,recorded_parameters,
  task_id,task_revision,execution_mode
  FROM runs`;

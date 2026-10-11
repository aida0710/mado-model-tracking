-- Indexes on the referencing columns of foreign keys into the tables a Project purge deletes from
-- (PROJECT_PURGE_STEPS). The purge defers every check to its commit (migration 055), and for each
-- deleted row PostgreSQL then looks up the rows that still reference it. Without an index on the
-- referencing columns each lookup reads the whole referencing table, so the commit grew with the
-- square of the Project's size (8000 Artifacts took several seconds). Each index starts with the
-- foreign key's columns in the key's order; keys already served by an index that starts with the
-- same columns, or with the key's first column (the referencing id), are not repeated here.
-- project-purge.integration.test.ts fails when a new foreign key into a purged table lacks one.
CREATE INDEX artifact_previews_preview_artifact ON artifact_previews(preview_artifact_id,project_id);
CREATE INDEX artifact_uploads_artifact ON artifact_uploads(artifact_id,project_id);
CREATE INDEX artifact_uploads_created_by_job_token ON artifact_uploads(created_by_job_token_id);
CREATE INDEX artifact_uploads_run ON artifact_uploads(run_id,project_id);
CREATE INDEX dataset_versions_source_run ON dataset_versions(source_run_id,project_id);
CREATE INDEX experiment_tasks_code_version ON experiment_tasks(code_version_id,project_id);
CREATE INDEX experiment_tasks_model_version ON experiment_tasks(model_version_id,project_id);
CREATE INDEX hook_executions_array_group ON hook_executions(array_group_id,project_id);
CREATE INDEX hook_executions_job ON hook_executions(job_id,project_id);
CREATE INDEX job_array_groups_hook ON job_array_groups(hook_id,project_id);
CREATE INDEX job_array_groups_parent_job ON job_array_groups(parent_job_id);
CREATE INDEX job_tokens_run ON job_tokens(run_id,project_id);
CREATE INDEX jobs_dataset_partition_version ON jobs(dataset_partition_version_id,project_id);
CREATE INDEX mlflow_logged_model_metrics_run ON mlflow_logged_model_metrics(run_id,project_id);
CREATE INDEX mlflow_logged_models_source_run ON mlflow_logged_models(source_run_id,project_id);
CREATE INDEX mlflow_run_dataset_inputs_dataset_version
  ON mlflow_run_dataset_inputs(dataset_version_id,project_id);
CREATE INDEX model_alias_events_previous_version ON model_alias_events(previous_version_id,model_id);
CREATE INDEX model_alias_events_promotion_evaluation ON model_alias_events(promotion_evaluation_id);
CREATE INDEX model_alias_events_version ON model_alias_events(version_id,model_id);
CREATE INDEX model_aliases_version ON model_aliases(version_id,model_id);
CREATE INDEX model_automation_events_source_run
  ON model_automation_events(source_run_id,project_id);
CREATE INDEX model_automation_executions_job ON model_automation_executions(job_id,project_id);
CREATE INDEX model_automation_executions_pipeline_root
  ON model_automation_executions(pipeline_root_execution_id,project_id);
CREATE INDEX model_automation_executions_trigger_run
  ON model_automation_executions(trigger_run_id,project_id);
CREATE INDEX model_automation_rules_code_version
  ON model_automation_rules(code_version_id,project_id);
CREATE INDEX model_automation_rules_experiment ON model_automation_rules(experiment_id,project_id);
CREATE INDEX model_promotion_evaluations_alias_event
  ON model_promotion_evaluations(alias_event_id);
CREATE INDEX model_promotion_evaluations_baseline_run
  ON model_promotion_evaluations(baseline_run_id,project_id);
CREATE INDEX model_promotion_evaluations_baseline_version
  ON model_promotion_evaluations(baseline_version_id,project_id);
CREATE INDEX model_promotion_evaluations_candidate_run
  ON model_promotion_evaluations(candidate_run_id,project_id);
CREATE INDEX model_promotion_policies_evaluation_rule
  ON model_promotion_policies(evaluation_rule_id,project_id);
CREATE INDEX model_promotion_policies_model ON model_promotion_policies(model_id,project_id);
CREATE INDEX model_versions_artifact ON model_versions(artifact_id,project_id);
CREATE INDEX model_versions_default_code_version
  ON model_versions(default_code_version_id,project_id);
CREATE INDEX notification_outbox_channel ON notification_outbox(channel_id);
CREATE INDEX notification_rules_channel ON notification_rules(channel_id);
CREATE INDEX run_media_thumbnail_artifact ON run_media(thumbnail_artifact_id,project_id);
CREATE INDEX run_output_declarations_dataset_version
  ON run_output_declarations(dataset_version_id,project_id);
CREATE INDEX run_output_declarations_model_version
  ON run_output_declarations(model_version_id,project_id);
CREATE INDEX runs_code_version ON runs(code_version_id,project_id);
CREATE INDEX sweep_trials_job ON sweep_trials(job_id);
CREATE INDEX sweeps_experiment ON sweeps(experiment_id);
CREATE INDEX sweeps_task ON sweeps(task_id);

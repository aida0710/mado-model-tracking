-- Metric names a rule's Runs are summarized by on the model version page, in display order.
-- reject_automation_rule_update compares the whole row except enabled, so the list is immutable
-- like the rest of the rule configuration without changing the trigger function.
ALTER TABLE model_automation_rules
  ADD COLUMN summary_metrics text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(summary_metrics) <= 20); -- MAX_SUMMARY_METRICS in modelAutomationValidation.ts

-- The model version page lists one version's executions newest first.
CREATE INDEX model_automation_executions_version
  ON model_automation_executions(model_version_id, created_at DESC, id DESC);
-- Run downstream lists read the children of one Run.
CREATE INDEX runs_parent_run_created ON runs(parent_run_id, created_at DESC, id DESC)
  WHERE parent_run_id IS NOT NULL;
-- The version page lists the inference and evaluation Runs that used one version.
CREATE INDEX runs_model_version_created ON runs(model_version_id, created_at DESC, id DESC)
  WHERE model_version_id IS NOT NULL;

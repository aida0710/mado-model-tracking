-- Versions registered while their source Run is still running wait for that Run's terminal
-- status; existing events were all processed at registration time.
ALTER TABLE model_automation_events
  ADD COLUMN state text NOT NULL DEFAULT 'processed'
    CHECK(state IN ('pending','processed','source_unsuccessful','source_timeout')),
  ADD COLUMN source_run_id uuid,
  ADD COLUMN pending_since timestamptz,
  ADD CONSTRAINT model_automation_events_source_run
    FOREIGN KEY(source_run_id,project_id) REFERENCES runs(id,project_id),
  ADD CONSTRAINT model_automation_events_pending_source
    CHECK(state<>'pending' OR (source_run_id IS NOT NULL AND pending_since IS NOT NULL));
CREATE INDEX model_automation_events_pending_run ON model_automation_events(source_run_id)
  WHERE state='pending';
CREATE INDEX model_automation_events_pending_since ON model_automation_events(pending_since)
  WHERE state='pending';

-- Conditions found by the operations monitor (stale Job heartbeat, offline worker, stalled plugin
-- delivery). A row is one occurrence from detection to resolution; notifications are queued only
-- when a row opens or resolves, so the monitor can re-check every tick without repeating them.
CREATE TABLE operations_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('job.heartbeat_stale','worker.offline','plugin.delivery_stalled')),
  -- Job id, '<token id>:<worker id>', or plugin connection id; text because the kinds differ.
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 300),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('recovered','inactive')),
  -- Snapshot when the alert opened: scalar values only, never secrets or remote responses.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
-- At most one open alert per subject, even if two monitors race past the advisory lock.
CREATE UNIQUE INDEX operations_alerts_open ON operations_alerts(kind, subject_id)
  WHERE resolved_at IS NULL;
CREATE INDEX operations_alerts_project ON operations_alerts(project_id, opened_at DESC, id DESC);

-- The plugin outbox summary reads the last delivery per plugin; delivered rows otherwise have no
-- index and the table keeps every event.
CREATE INDEX plugin_outbox_delivered ON plugin_outbox(plugin_id, delivered_at DESC)
  WHERE status = 'delivered';

-- A global administrator can delete an archived Project for good (DELETE /admin/projects/:p).
-- Every row of the Project goes except the projects row itself, which stays as a tombstone
-- (name only): users are never deleted, so the Project's Service Accounts keep pointing at it, and
-- audit events keep naming the Project and the API tokens that acted in it.
ALTER TABLE projects
  ADD COLUMN purged_at timestamptz,
  ADD COLUMN purged_by uuid REFERENCES users(id),
  ADD CONSTRAINT projects_purged_by CHECK ((purged_at IS NULL) = (purged_by IS NULL)),
  -- Only an archived Project can be purged, and a purged one cannot be restored.
  ADD CONSTRAINT projects_purged_archived CHECK (purged_at IS NULL OR archived_at IS NOT NULL);

-- Blobs of a purged Project's Artifacts and upload sessions. The rows that named them are gone,
-- so the ArtifactGarbageCollector removes these after MMT_ARTIFACT_DELETE_GRACE_DAYS, like the
-- blobs of deleted Artifacts (artifact_deletions).
CREATE TABLE purged_project_blobs (
  -- Names the blob in logs, where storage keys (which reveal the bucket layout) are not written.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backend text NOT NULL,
  storage_key text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  queued_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removal_attempts integer NOT NULL DEFAULT 0 CHECK (removal_attempts >= 0),
  -- An error name such as NoSuchBucket or EACCES, never storage locations or credentials.
  last_removal_error text CHECK (last_removal_error IS NULL OR length(last_removal_error) <= 64),
  UNIQUE (backend, storage_key)
);
CREATE INDEX purged_project_blobs_pending ON purged_project_blobs(queued_at)
  WHERE removed_at IS NULL;

-- The rows of one Project reference each other in cycles (a Run and the checkpoint it resumes
-- from, a Job and its array, a model version and the Run that produced it), so no deletion order
-- satisfies every foreign key. The purge defers the checks to its commit with SET CONSTRAINTS ALL
-- DEFERRED; INITIALLY IMMEDIATE keeps every other transaction checking at once, as before. A row
-- of another Project that still pointed at a purged row would fail the commit, not dangle.
DO $$
DECLARE
  foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT c.conname, c.conrelid::regclass AS table_name FROM pg_constraint c
    WHERE c.contype = 'f' AND NOT c.condeferrable AND c.connamespace = current_schema()::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      foreign_key.table_name, foreign_key.conname);
  END LOOP;
END;
$$;

-- Append-only and immutable history may be deleted only together with its Project: the purging
-- transaction sets purged_at first, so these triggers let it through and refuse everyone else.
CREATE FUNCTION project_is_purged(project uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM projects WHERE id = project AND purged_at IS NOT NULL)
$$;
CREATE FUNCTION reject_delete_outside_project_purge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF project_is_purged(OLD.project_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% rows can only be deleted by purging their Project', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;
-- Report revisions and snapshots reach their Project through the report.
CREATE FUNCTION reject_report_history_delete_outside_project_purge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF project_is_purged((SELECT project_id FROM reports WHERE id = OLD.report_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows can only be deleted by purging their Project', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

-- The guards below kept refusing UPDATE OR DELETE in one trigger. They now refuse UPDATE as before,
-- and a separate trigger decides DELETE.
DROP TRIGGER model_alias_events_append_only ON model_alias_events;
CREATE TRIGGER model_alias_events_append_only BEFORE UPDATE ON model_alias_events
  FOR EACH ROW EXECUTE FUNCTION reject_model_alias_event_change();
CREATE TRIGGER model_alias_events_kept BEFORE DELETE ON model_alias_events
  FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_project_purge();

DROP TRIGGER model_promotion_evaluations_append_only ON model_promotion_evaluations;
CREATE TRIGGER model_promotion_evaluations_append_only BEFORE UPDATE ON model_promotion_evaluations
  FOR EACH ROW EXECUTE FUNCTION reject_promotion_evaluation_change();
CREATE TRIGGER model_promotion_evaluations_kept BEFORE DELETE ON model_promotion_evaluations
  FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_project_purge();

DROP TRIGGER run_resume_events_append_only ON run_resume_events;
CREATE TRIGGER run_resume_events_append_only BEFORE UPDATE ON run_resume_events
  FOR EACH ROW EXECUTE FUNCTION reject_run_resume_event_change();
CREATE TRIGGER run_resume_events_kept BEFORE DELETE ON run_resume_events
  FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_project_purge();

DROP TRIGGER run_checkpoints_immutable ON run_checkpoints;
CREATE TRIGGER run_checkpoints_immutable BEFORE UPDATE ON run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION guard_run_checkpoint_change();
CREATE TRIGGER run_checkpoints_kept BEFORE DELETE ON run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_project_purge();

DROP TRIGGER report_revisions_immutable ON report_revisions;
CREATE TRIGGER report_revisions_immutable BEFORE UPDATE ON report_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_report_revision_change();
CREATE TRIGGER report_revisions_kept BEFORE DELETE ON report_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_report_history_delete_outside_project_purge();

DROP TRIGGER report_block_snapshots_immutable ON report_block_snapshots;
CREATE TRIGGER report_block_snapshots_immutable BEFORE UPDATE ON report_block_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_report_revision_change();
CREATE TRIGGER report_block_snapshots_kept BEFORE DELETE ON report_block_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_report_history_delete_outside_project_purge();

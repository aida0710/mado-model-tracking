-- Shared reports. The content lives in immutable revisions; `reports` keeps the head (title and
-- number of the current revision) and the archive state. Reports are archived, never deleted, in
-- line with the audit policy (decisions.md). Blocks are validated by the API (domain/reportBlocks.ts).
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 300),
  current_revision integer NOT NULL CHECK(current_revision >= 1),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by uuid REFERENCES users(id),
  CHECK((archived_at IS NULL) = (archived_by IS NULL))
);
-- The list is newest first and pages by (updated_at,id).
CREATE INDEX reports_project_updated ON reports(project_id,updated_at DESC,id DESC);

CREATE TABLE report_revisions (
  report_id uuid NOT NULL REFERENCES reports(id),
  revision integer NOT NULL CHECK(revision >= 1),
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 300),
  blocks jsonb NOT NULL CHECK(jsonb_typeof(blocks) = 'array'),
  message text CHECK(char_length(message) <= 1000),
  -- Set when POST /restore copied an earlier revision.
  restored_from_revision integer,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(report_id,revision),
  CHECK(restored_from_revision IS NULL OR restored_from_revision BETWEEN 1 AND revision - 1)
);

-- Data of the snapshot-mode blocks of one revision. An unchanged block carries the row of the
-- previous revision over (same data, captured_at and captured_revision), so its time is kept.
CREATE TABLE report_block_snapshots (
  report_id uuid NOT NULL,
  revision integer NOT NULL,
  block_id text NOT NULL,
  data jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  captured_revision integer NOT NULL CHECK(captured_revision BETWEEN 1 AND revision),
  size_bytes integer NOT NULL CHECK(size_bytes >= 0),
  PRIMARY KEY(report_id,revision,block_id),
  FOREIGN KEY(report_id,revision) REFERENCES report_revisions(report_id,revision)
);

CREATE FUNCTION reject_report_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Report revisions and their snapshots are immutable' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER report_revisions_immutable BEFORE UPDATE OR DELETE ON report_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_report_revision_change();
CREATE TRIGGER report_block_snapshots_immutable BEFORE UPDATE OR DELETE ON report_block_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_report_revision_change();

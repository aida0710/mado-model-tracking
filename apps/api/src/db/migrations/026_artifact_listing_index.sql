-- Run Artifact lists page in path order and pick the newest upload per path, so one index serves
-- the ordered scan, the LIKE prefix (C collation makes it a range), and the "newer version" probe.
CREATE INDEX artifacts_run_path_listing ON artifacts(project_id,run_id,path COLLATE "C",created_at DESC,id DESC);
-- The Project catalog pages newest first with a (created_at,id) keyset.
CREATE INDEX artifacts_project_catalog_order ON artifacts(project_id,created_at DESC,id DESC);

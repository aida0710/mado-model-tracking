-- POST /runs/search pages active Runs newest first with a (created_at,id) keyset.
-- The partial index reads one page without sorting the whole Project history.
-- GIN indexes on tags/parameters/recorded_parameters were measured and not added:
-- the compiled filters use ->> comparisons, which jsonb_path_ops cannot serve
-- (artifacts/verification/2026-10-08/run-search/).
CREATE INDEX runs_active_search_order ON runs(project_id,created_at DESC,id DESC)
  WHERE lifecycle_stage='active';

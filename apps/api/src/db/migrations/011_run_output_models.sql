-- Native and MLflow registrations number model versions from this single counter.
-- mlflow_registered_model_metadata.next_version is kept only so the migration stays
-- reversible; it is no longer read or written because two counters can disagree.
ALTER TABLE models ADD COLUMN next_version bigint NOT NULL DEFAULT 1 CHECK(next_version > 0);

-- Integer versions longer than 18 digits do not fit the bigint counter and are treated
-- like non-integer versions (kept, but excluded from numbering).
UPDATE models m SET next_version=GREATEST(
  COALESCE((SELECT MAX(v.version::numeric)+1 FROM model_versions v
    WHERE v.model_id=m.id AND v.version ~ '^[0-9]{1,18}$'),1),
  COALESCE((SELECT mm.next_version FROM mlflow_registered_model_metadata mm WHERE mm.model_id=m.id),1)
)::bigint;

-- Run.outputModelVersionIds is derived from model_versions.source_run_id per Run.
CREATE INDEX model_versions_source_run ON model_versions(project_id,source_run_id)
  WHERE source_run_id IS NOT NULL;

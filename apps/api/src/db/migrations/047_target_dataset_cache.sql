-- How a worker materializes input DatasetVersions on this target before a Job starts.
-- dataset_cache_max_bytes bounds <workDirectory>/.mmt-cache/datasets; the worker deletes the least
-- recently used entries that no unfinished Job uses. The default is 100GiB, a size most GPU hosts'
-- work directories hold next to model weights; administrators change it per target.
-- dataset_transfer 'relay': the worker downloads from the API and forwards to the target (GPU hosts
-- often cannot reach the API, decisions.md). 'direct': the target downloads with the Job token.
ALTER TABLE compute_targets
  ADD COLUMN dataset_cache_max_bytes bigint NOT NULL DEFAULT 107374182400
    CHECK (dataset_cache_max_bytes > 0),
  ADD COLUMN dataset_transfer text NOT NULL DEFAULT 'relay'
    CHECK (dataset_transfer IN ('relay','direct'));

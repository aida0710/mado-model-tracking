-- Connection checks for ComputeTargets. The API holds no SSH key, so a worker in charge of the
-- target claims the check, probes the target over its own key and reports a structured result.
CREATE TABLE target_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES compute_targets(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','finished','failed')),
  worker_token_id uuid,
  worker_id text CHECK(char_length(worker_id) BETWEEN 1 AND 200),
  lease_id uuid,
  result jsonb,
  -- Set when the check ended without a worker result (see TargetCheckFailureReason).
  failure_reason text CHECK(failure_reason IN ('no_worker','claim_timeout')),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  CHECK(status <> 'queued' OR lease_id IS NULL),
  CHECK(status <> 'claimed' OR lease_id IS NOT NULL),
  CHECK((status IN ('finished','failed')) = (finished_at IS NOT NULL)),
  CHECK(failure_reason IS NULL OR (status = 'failed' AND result IS NULL))
);
-- One check in progress per target, so repeated clicks cannot pile up SSH sessions.
CREATE UNIQUE INDEX target_checks_one_open ON target_checks(target_id) WHERE status IN ('queued','claimed');
CREATE INDEX target_checks_target_created ON target_checks(target_id,created_at DESC,id DESC);
CREATE INDEX target_checks_queued ON target_checks(created_at) WHERE status = 'queued';

-- External execution (docs/design/external-execution.md). A site is a computer that tracking only
-- describes: a launcher (or the requester with `mado-tracking submit` on sites with OTP) submits
-- its Jobs through the site's own job shell, and the runner on the compute node reports back.
ALTER TABLE compute_targets DROP CONSTRAINT compute_targets_executor_check;
ALTER TABLE compute_targets ADD CONSTRAINT compute_targets_executor_check
  CHECK (executor IN ('ssh','local','site'));
ALTER TABLE compute_targets
  ADD COLUMN submission_mode text NOT NULL DEFAULT 'automatic'
    CHECK (submission_mode IN ('automatic','manual')),
  ADD COLUMN cpu_arch text NOT NULL DEFAULT 'amd64' CHECK (cpu_arch IN ('amd64','arm64')),
  ADD COLUMN supports_array boolean NOT NULL DEFAULT false,
  ADD COLUMN queue_timeout_seconds integer CHECK (queue_timeout_seconds > 0);
-- Only sites are submitted by hand, in arrays, or wait in a scheduler queue; sites run containers only.
ALTER TABLE compute_targets ADD CONSTRAINT target_site_settings CHECK (
  executor = 'site'
  OR (submission_mode = 'automatic' AND NOT supports_array AND queue_timeout_seconds IS NULL)
);
ALTER TABLE compute_targets ADD CONSTRAINT target_site_containers
  CHECK (executor <> 'site' OR NOT ('python' = ANY(runtime_kinds)));

-- Settings fixed at creation except enabled, like automation rules: a change is a new hook.
CREATE TABLE hooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  trigger text NOT NULL CHECK (trigger IN
    ('manual','model_registered','run_finished','array_finished','checkpoint_saved','webhook')),
  filter jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filter) = 'object'),
  template jsonb NOT NULL CHECK (jsonb_typeof(template) = 'object'),
  checkpoint_mode text NOT NULL DEFAULT 'every'
    CHECK (checkpoint_mode IN ('every','every_k','latest','skip_if_running')),
  checkpoint_every integer CHECK (checkpoint_every BETWEEN 1 AND 100000),
  concurrency text NOT NULL DEFAULT 'queue' CHECK (concurrency IN ('queue','skip_if_running')),
  max_starts_per_hour integer NOT NULL DEFAULT 60 CHECK (max_starts_per_hour BETWEEN 1 AND 10000),
  webhook_signature text CHECK (webhook_signature IN ('github','mmt')),
  -- AES-256-GCM with MMT_HOOK_SECRET_KEY; the HMAC check needs the secret itself, not a hash.
  webhook_secret_key_id text,
  webhook_secret_payload bytea,
  created_by uuid NOT NULL REFERENCES users(id),
  run_as_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id),
  CHECK ((trigger = 'webhook') = (webhook_signature IS NOT NULL)),
  CHECK ((webhook_signature IS NULL) = (webhook_secret_payload IS NULL)),
  CHECK ((webhook_secret_payload IS NULL) = (webhook_secret_key_id IS NULL)),
  CHECK ((checkpoint_mode = 'every_k') = (checkpoint_every IS NOT NULL))
);
CREATE INDEX hooks_project ON hooks(project_id, created_at DESC, id DESC);
CREATE INDEX hooks_enabled_trigger ON hooks(project_id, trigger) WHERE enabled;

CREATE FUNCTION reject_hook_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled') THEN
    RAISE EXCEPTION 'Hook configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hooks_immutable BEFORE UPDATE ON hooks FOR EACH ROW EXECUTE FUNCTION reject_hook_update();

-- Members of one array submission. A member's retries keep its index, so the group ends when
-- every index has a terminal attempt and no retry is left to start.
CREATE TABLE job_array_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  target_id uuid NOT NULL REFERENCES compute_targets(id),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10000),
  created_by uuid NOT NULL REFERENCES users(id),
  -- The driver Job that created the group, and the key that makes its resend return this group.
  parent_job_id uuid,
  idempotency_key text CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  hook_id uuid,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id),
  FOREIGN KEY (hook_id, project_id) REFERENCES hooks(id, project_id),
  CHECK ((idempotency_key IS NULL) OR (parent_job_id IS NOT NULL))
);
CREATE UNIQUE INDEX job_array_groups_child_key ON job_array_groups(parent_job_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE jobs
  -- Where a site Job is between queued and its end; NULL for ssh and local Jobs.
  ADD COLUMN phase text CHECK (phase IN
    ('waiting_manual','submitting','submitted','waiting_resources','running')),
  ADD COLUMN gpu_count integer NOT NULL DEFAULT 0 CHECK (gpu_count BETWEEN 0 AND 64),
  ADD COLUMN walltime_seconds integer CHECK (walltime_seconds > 0),
  ADD COLUMN scheduler_job_id text CHECK (char_length(scheduler_job_id) BETWEEN 1 AND 200),
  -- A Job canceled while it waited in a scheduler queue: the launcher removes it from the queue.
  ADD COLUMN scheduler_cancel_state text CHECK (scheduler_cancel_state IN ('pending','done')),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN runner_instance_id uuid,
  ADD COLUMN runner_host text CHECK (char_length(runner_host) BETWEEN 1 AND 253),
  ADD COLUMN array_group_id uuid,
  ADD COLUMN array_index integer CHECK (array_index >= 0),
  ADD COLUMN end_reason text CHECK (end_reason IN ('timed_out','queue_timeout','submit_failed')),
  ADD COLUMN parent_job_id uuid REFERENCES jobs(id),
  ADD COLUMN chain_depth integer NOT NULL DEFAULT 0 CHECK (chain_depth >= 0),
  ADD COLUMN hook_id uuid,
  -- Hooks along the chain that led to this Job; a hook never starts twice in one chain.
  ADD COLUMN hook_chain uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN allow_child_jobs boolean NOT NULL DEFAULT false,
  ADD COLUMN retry_on_failure boolean NOT NULL DEFAULT false,
  ADD COLUMN retry_on_timeout boolean NOT NULL DEFAULT false,
  ADD COLUMN dataset_partition_version_id uuid,
  ADD COLUMN idempotency_key text CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT jobs_array_member CHECK ((array_group_id IS NULL) = (array_index IS NULL)),
  ADD CONSTRAINT jobs_child_key CHECK (idempotency_key IS NULL OR parent_job_id IS NOT NULL),
  ADD FOREIGN KEY (array_group_id, project_id) REFERENCES job_array_groups(id, project_id),
  ADD FOREIGN KEY (hook_id, project_id) REFERENCES hooks(id, project_id),
  ADD FOREIGN KEY (dataset_partition_version_id, project_id)
    REFERENCES dataset_versions(id, project_id);
-- Existing ssh/local Jobs requested exactly their GPU IDs.
UPDATE jobs SET gpu_count = cardinality(gpu_ids);
ALTER TABLE job_array_groups ADD FOREIGN KEY (parent_job_id) REFERENCES jobs(id);
CREATE UNIQUE INDEX jobs_array_attempt ON jobs(array_group_id, array_index, attempt)
  WHERE array_group_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_child_key ON jobs(parent_job_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_parent ON jobs(parent_job_id) WHERE parent_job_id IS NOT NULL;
CREATE INDEX jobs_hook ON jobs(hook_id) WHERE hook_id IS NOT NULL;
CREATE INDEX jobs_site_submitted ON jobs(target_id, submitted_at) WHERE phase = 'submitted';
-- What a launcher still has to remove from a scheduler queue.
CREATE INDEX jobs_scheduler_cancel ON jobs(worker_token_id, worker_id)
  WHERE scheduler_cancel_state = 'pending';

ALTER TABLE experiment_tasks
  ADD COLUMN gpu_count integer NOT NULL DEFAULT 0 CHECK (gpu_count BETWEEN 0 AND 64),
  ADD COLUMN walltime_seconds integer CHECK (walltime_seconds > 0);

-- One start of a hook. event_key makes a repeated event (a resent webhook, a Run that ends
-- twice) find the same row instead of starting again.
CREATE TABLE hook_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  hook_id uuid NOT NULL,
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 300),
  subject_kind text NOT NULL CHECK (subject_kind IN
    ('manual','model_version','run','array_group','checkpoint','webhook')),
  subject_id text CHECK (char_length(subject_id) <= 300),
  status text NOT NULL CHECK (status IN ('pending','queued','skipped','failed')),
  reason text CHECK (reason IN ('loop_detected','chain_too_deep','rate_limited','already_running',
    'owner_access_revoked','superseded','source_run_unsuccessful','source_run_timeout','hook_disabled')),
  error text,
  job_id uuid,
  array_group_id uuid,
  run_id uuid,
  payload jsonb,
  -- A pending execution starts when this Run ends (a training Run that registered the version,
  -- or the Run whose earlier checkpoint is still being evaluated under the 'latest' mode).
  waiting_run_id uuid,
  checkpoint_id uuid,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hook_id, event_key),
  FOREIGN KEY (hook_id, project_id) REFERENCES hooks(id, project_id),
  FOREIGN KEY (job_id, project_id) REFERENCES jobs(id, project_id),
  FOREIGN KEY (array_group_id, project_id) REFERENCES job_array_groups(id, project_id),
  CHECK ((status = 'skipped') = (reason IS NOT NULL)),
  CHECK (status <> 'pending' OR waiting_run_id IS NOT NULL)
);
CREATE INDEX hook_executions_list ON hook_executions(project_id, created_at DESC, id DESC);
CREATE INDEX hook_executions_hook ON hook_executions(hook_id, created_at DESC);
CREATE INDEX hook_executions_waiting ON hook_executions(waiting_run_id) WHERE status = 'pending';

-- Notification channels (destinations), Project rules choosing events per channel, and the outbox
-- that delivers each matched event with a lease and backoff like plugin_outbox.

-- Webhook URLs and signing secrets stay in the server environment: url_env and secret_env only
-- name variables (prefix MMT_NOTIFICATION_). project_id NULL makes the channel usable by every
-- Project. Global administrators create and edit channels.
CREATE TABLE notification_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  kind text NOT NULL CHECK (kind IN ('slack_webhook','webhook','email')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url_env text CHECK (url_env ~ '^MMT_NOTIFICATION_[A-Z0-9_]+$'),
  secret_env text CHECK (secret_env ~ '^MMT_NOTIFICATION_[A-Z0-9_]+$'),
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recipients) = 'array' AND jsonb_array_length(recipients) <= 50),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Slack and webhook need a URL; a webhook is always signed; email needs recipients.
  CHECK (
    (kind = 'slack_webhook' AND url_env IS NOT NULL AND secret_env IS NULL
      AND jsonb_array_length(recipients) = 0)
    OR (kind = 'webhook' AND url_env IS NOT NULL AND secret_env IS NOT NULL
      AND jsonb_array_length(recipients) = 0)
    OR (kind = 'email' AND url_env IS NULL AND secret_env IS NULL
      AND jsonb_array_length(recipients) > 0)
  )
);
CREATE UNIQUE INDEX notification_channels_global_name ON notification_channels(name)
  WHERE project_id IS NULL;
CREATE UNIQUE INDEX notification_channels_project_name ON notification_channels(project_id, name)
  WHERE project_id IS NOT NULL;

-- Project admins choose which events go to which channel. Settings are fixed; only enabled changes.
CREATE TABLE notification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  channel_id uuid NOT NULL REFERENCES notification_channels(id),
  event_types text[] NOT NULL CHECK (
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['run.failed','run.canceled','run.finished','automation.failed',
      'job.heartbeat_stale','job.heartbeat_recovered','worker.offline',
      'plugin.delivery_stalled']::text[]
  ),
  -- {runKinds?, experimentIds?, automationOnly?}; validated by the API.
  filter jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filter) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_rules_project ON notification_rules(project_id, created_at DESC, id DESC);

-- One row per (rule, event). dedupe_key (event type + subject, such as the Run id) keeps a
-- repeated completion from queuing the same notification twice. event holds the immutable payload.
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  rule_id uuid NOT NULL REFERENCES notification_rules(id),
  channel_id uuid NOT NULL REFERENCES notification_channels(id),
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 500),
  event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- Lease token of the dispatcher currently sending; cleared when the attempt ends.
  delivery_id uuid,
  locked_at timestamptz,
  last_error text,
  -- X-MMT-Delivery of the last attempt, for matching the receiver's logs.
  sent_delivery_id uuid,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, dedupe_key)
);
CREATE INDEX notification_outbox_due ON notification_outbox(next_attempt_at)
  WHERE status IN ('pending','sending');
CREATE INDEX notification_outbox_project ON notification_outbox(project_id, created_at DESC, id DESC);

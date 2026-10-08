-- Audit rows are kept indefinitely. project_id has no foreign key so denied requests
-- against missing or inaccessible Projects can still be recorded.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','token','system')),
  actor_user_id uuid REFERENCES users(id),
  actor_token_id uuid REFERENCES api_tokens(id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK (outcome IN ('success','denied','failed')),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 100),
  resource_id text CHECK (length(resource_id) <= 500),
  project_id uuid,
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details)='object'),
  ip text CHECK (length(ip) <= 100),
  user_agent text CHECK (length(user_agent) <= 1000),
  CHECK (
    (actor_type='user' AND actor_user_id IS NOT NULL AND actor_token_id IS NULL)
    OR (actor_type='token' AND actor_user_id IS NOT NULL AND actor_token_id IS NOT NULL)
    OR (actor_type='system' AND actor_user_id IS NULL AND actor_token_id IS NULL)
  )
);
CREATE INDEX audit_events_occurred ON audit_events(occurred_at DESC);
CREATE INDEX audit_events_project ON audit_events(project_id,occurred_at DESC);

CREATE FUNCTION reject_audit_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_change();

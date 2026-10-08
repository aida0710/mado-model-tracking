-- Groups an SSO user held at the last sync. Project group bindings join on this table,
-- so the current groups are queryable without reading the per-login array.
CREATE TABLE user_groups (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 256),
  source text NOT NULL DEFAULT 'oidc' CHECK (source IN ('oidc')),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_name)
);
CREATE INDEX user_groups_group ON user_groups(group_name);
-- Existing SSO users get their last login's groups so bindings work before they log in again.
INSERT INTO user_groups(user_id,group_name,synced_at)
SELECT DISTINCT i.user_id,g.group_name,COALESCE(i.last_login_at,i.created_at)
FROM user_oidc_identities i CROSS JOIN LATERAL unnest(i.groups_at_login) AS g(group_name)
WHERE length(g.group_name) BETWEEN 1 AND 256
ON CONFLICT DO NOTHING;

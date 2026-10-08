-- Stub of auth-project-group-bindings-api's migration so this worktree can test against
-- effective_project_roles; the owner's file replaces it on integration.
CREATE TABLE project_group_bindings (
  project_id uuid NOT NULL REFERENCES projects(id),
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('viewer','editor','admin')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, group_name)
);

CREATE VIEW effective_project_roles AS
WITH grants AS (
  SELECT project_id, user_id, role, 'direct' AS source FROM project_members
  UNION ALL
  SELECT b.project_id, g.user_id, b.role, 'group:' || b.group_name
  FROM project_group_bindings b JOIN user_groups g ON g.group_name = b.group_name
), ranked AS (
  SELECT project_id, user_id, source,
    CASE role WHEN 'viewer' THEN 1 WHEN 'editor' THEN 2 WHEN 'admin' THEN 3 END AS rank
  FROM grants
)
SELECT project_id, user_id,
  CASE max(rank) WHEN 1 THEN 'viewer' WHEN 2 THEN 'editor' ELSE 'admin' END AS role,
  array_agg(source ORDER BY source) AS sources
FROM ranked GROUP BY project_id, user_id;

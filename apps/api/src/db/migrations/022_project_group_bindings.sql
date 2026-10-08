-- Minimal stub for promotion-policy-gate's worktree. The owner is auth-project-group-bindings-api;
-- the parent keeps the owner's version when the wave is integrated.
CREATE TABLE project_group_bindings (
  project_id uuid NOT NULL REFERENCES projects(id),
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('viewer','editor','admin')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, group_name)
);

CREATE VIEW effective_project_roles AS
WITH grants AS (
  SELECT project_id, user_id, role, 'direct'::text AS source FROM project_members
  UNION ALL
  SELECT b.project_id, g.user_id, b.role, 'group:' || b.group_name
  FROM project_group_bindings b JOIN user_groups g ON g.group_name = b.group_name
), ranked AS (
  SELECT project_id, user_id, source,
    CASE role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS rank
  FROM grants
)
SELECT project_id, user_id,
  CASE max(rank) WHEN 3 THEN 'admin' WHEN 2 THEN 'editor' ELSE 'viewer' END AS role,
  array_agg(source ORDER BY source) AS sources
FROM ranked GROUP BY project_id, user_id;

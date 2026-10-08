-- A Project role given to every user in an SSO group (user_groups). Project admins manage the
-- rows; each change is audited. Direct grants stay in project_members.
CREATE TABLE project_group_bindings (
  project_id uuid NOT NULL REFERENCES projects(id),
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('viewer','editor','admin')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, group_name)
);
CREATE INDEX project_group_bindings_group ON project_group_bindings(group_name);

-- Every authorization decision reads the Project role from here: the strongest of the direct
-- grant and the bindings of the groups the user held at the last SSO sync. sources lists
-- 'direct' and 'group:<name>' for each grant that contributed, strongest or not.
CREATE VIEW effective_project_roles AS
WITH grants AS (
  SELECT m.project_id, m.user_id, m.role, 'direct' AS source FROM project_members m
  UNION ALL
  SELECT b.project_id, g.user_id, b.role, 'group:' || b.group_name AS source
  FROM project_group_bindings b JOIN user_groups g ON g.group_name = b.group_name
)
SELECT project_id, user_id,
  (ARRAY['viewer','editor','admin'])[max(CASE role WHEN 'viewer' THEN 1 WHEN 'editor' THEN 2 WHEN 'admin' THEN 3 END)] AS role,
  array_agg(source ORDER BY source) AS sources
FROM grants
GROUP BY project_id, user_id;

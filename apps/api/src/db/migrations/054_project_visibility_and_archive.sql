-- A Project is public (every active person may work in it as an editor without being a member) or
-- private (members only). A Project admin can archive a Project: it disappears from every list
-- and API, keeps its data, and a global administrator can restore it.
ALTER TABLE projects
  ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES users(id),
  ADD CONSTRAINT projects_archived_by CHECK ((archived_at IS NULL) = (archived_by IS NULL));
-- Existing Projects keep their current audience (the column was added as private); new Projects
-- are public unless their creator chooses otherwise.
ALTER TABLE projects ALTER COLUMN visibility SET DEFAULT 'public';

-- The order of Project roles. domain/projectRoles.ts ranks them the same way.
CREATE FUNCTION project_role_rank(role text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE role WHEN 'viewer' THEN 1 WHEN 'editor' THEN 2 WHEN 'admin' THEN 3 END
$$;
CREATE FUNCTION project_role_of_rank(rank integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT (ARRAY['viewer','editor','admin'])[rank]
$$;

-- Every grant of a Project role, one row each: the direct grant ('direct'), each bound group the
-- user is in ('group:<name>'), and 'public' for every active person on a public Project. Public
-- access is never admin and never reaches Service Accounts or launchers.
CREATE VIEW project_role_grants AS
  SELECT m.project_id, m.user_id, m.role, 'direct' AS source FROM project_members m
  UNION ALL
  SELECT b.project_id, g.user_id, b.role, 'group:' || b.group_name
  FROM project_group_bindings b JOIN user_groups g ON g.group_name = b.group_name
  UNION ALL
  SELECT p.id, u.id, 'editor', 'public'
  FROM projects p JOIN users u ON u.kind = 'human' AND u.status = 'active'
  WHERE p.visibility = 'public';

-- Membership: the strongest direct grant or group binding, without public access and whether or
-- not the Project is archived. Member lists and the administrators' member count read this.
CREATE VIEW project_membership_roles AS
SELECT project_id, user_id, project_role_of_rank(max(project_role_rank(role))) AS role,
  array_agg(source ORDER BY source) AS sources
FROM project_role_grants WHERE source <> 'public'
GROUP BY project_id, user_id;

-- Every authorization decision still reads the Project role from here (migration 022): now the
-- strongest of membership and public access. An archived Project grants nothing to anyone.
CREATE OR REPLACE VIEW effective_project_roles AS
SELECT g.project_id, g.user_id, project_role_of_rank(max(project_role_rank(g.role))) AS role,
  array_agg(g.source ORDER BY g.source) AS sources
FROM project_role_grants g JOIN projects p ON p.id = g.project_id AND p.archived_at IS NULL
GROUP BY g.project_id, g.user_id;

import type { ProjectGroupBinding, ProjectRole } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

const bindingColumns = 'project_id,group_name AS "group",role,created_by,created_at';

export async function listGroupBindings(
  connection: Connection,
  projectId: string,
): Promise<ProjectGroupBinding[]> {
  return rows<ProjectGroupBinding>(
    connection,
    `SELECT ${bindingColumns} FROM project_group_bindings WHERE project_id=$1 ORDER BY group_name`,
    [projectId],
  );
}

export async function findGroupBinding(
  connection: Connection,
  binding: { projectId: string; group: string },
): Promise<ProjectGroupBinding | undefined> {
  return first<ProjectGroupBinding>(
    connection,
    `SELECT ${bindingColumns} FROM project_group_bindings WHERE project_id=$1 AND group_name=$2`,
    [binding.projectId, binding.group],
  );
}

// A role change keeps the original creator; the audit log holds who changed it.
export async function upsertGroupBinding(
  connection: Connection,
  binding: { projectId: string; group: string; role: ProjectRole; createdBy: string },
): Promise<ProjectGroupBinding> {
  return (await first<ProjectGroupBinding>(
    connection,
    `INSERT INTO project_group_bindings(project_id,group_name,role,created_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(project_id,group_name) DO UPDATE SET role=EXCLUDED.role RETURNING ${bindingColumns}`,
    [binding.projectId, binding.group, binding.role, binding.createdBy],
  ))!;
}

export async function deleteGroupBinding(
  connection: Connection,
  binding: { projectId: string; group: string },
): Promise<void> {
  await connection.query('DELETE FROM project_group_bindings WHERE project_id=$1 AND group_name=$2', [
    binding.projectId,
    binding.group,
  ]);
}

import type { ShareableProject } from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';

/**
 * The Projects an owner may share their computer with: those where they create Jobs themselves,
 * as an editor or above by their effective role (direct grant or SSO group binding).
 */
export async function listShareableProjects(
  connection: Connection,
  ownerUserId: string,
): Promise<ShareableProject[]> {
  return rows<ShareableProject>(
    connection,
    `SELECT p.id,p.name FROM projects p JOIN effective_project_roles e ON e.project_id=p.id
    WHERE e.user_id=$1 AND e.role IN ('editor','admin') ORDER BY p.name,p.id`,
    [ownerUserId],
  );
}

/** The Projects each owned computer is shared with, by target ID. */
export async function listTargetProjects(
  connection: Connection,
  targetIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (!targetIds.length) return new Map();
  const found = await rows<{ targetId: string; projectIds: string[] }>(
    connection,
    `SELECT target_id,array_agg(project_id ORDER BY project_id) AS project_ids FROM compute_target_projects
    WHERE target_id=ANY($1::uuid[]) GROUP BY target_id`,
    [targetIds],
  );
  return new Map(found.map((row) => [row.targetId, row.projectIds]));
}

export async function replaceTargetProjects(
  connection: Connection,
  sharing: { targetId: string; projectIds: string[]; createdBy: string },
): Promise<void> {
  await connection.query(
    'DELETE FROM compute_target_projects WHERE target_id=$1 AND NOT (project_id=ANY($2::uuid[]))',
    [sharing.targetId, sharing.projectIds],
  );
  await connection.query(
    `INSERT INTO compute_target_projects(target_id,project_id,created_by)
    SELECT $1,project_id,$3 FROM unnest($2::uuid[]) AS p(project_id) ON CONFLICT DO NOTHING`,
    [sharing.targetId, sharing.projectIds, sharing.createdBy],
  );
}

/**
 * Who may run Jobs on a computer, in SQL over compute_targets `t`: a global one serves everyone;
 * an owned one its owner, and the Projects it is shared with ($project, or any Project the user
 * is a member of when $project is NULL).
 */
export function targetUsableSql(user: string, project: string): string {
  return `(t.owner_user_id IS NULL OR t.owner_user_id=${user} OR EXISTS(
    SELECT 1 FROM compute_target_projects sp WHERE sp.target_id=t.id AND (
      sp.project_id=${project} OR (${project} IS NULL AND EXISTS(
        SELECT 1 FROM effective_project_roles e WHERE e.project_id=sp.project_id AND e.user_id=${user})))))`;
}

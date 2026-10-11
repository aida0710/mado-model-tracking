import type { AdminProject, Project } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

/** A Project row as the API returns it, without the caller's role. */
export type ProjectRecord = Omit<Project, 'role'>;

// The Project fields of the API (Project without role); archive and purge columns stay internal.
export const PROJECT_COLUMNS =
  'p.id,p.name,p.description,p.artifact_backend,p.visibility,p.created_at';

/**
 * SQL that is true while the Project named by `projectParameter` (a placeholder such as `$2`) is
 * not archived. Owner checks of background work use it, so a global administrator's automation
 * stops with the Project as a member's does.
 */
export function liveProjectSql(projectParameter: string): string {
  return `EXISTS(SELECT 1 FROM projects live_project WHERE live_project.id=${projectParameter} AND live_project.archived_at IS NULL)`;
}

export async function insertProject(
  connection: Connection,
  project: Pick<ProjectRecord, 'name' | 'description' | 'artifactBackend' | 'visibility'>,
): Promise<ProjectRecord> {
  return (await first<ProjectRecord>(
    connection,
    `INSERT INTO projects AS p(name,description,artifact_backend,visibility) VALUES($1,$2,$3,$4)
    RETURNING ${PROJECT_COLUMNS}`,
    [project.name, project.description, project.artifactBackend, project.visibility],
  ))!;
}

export async function updateProject(
  connection: Connection,
  change: { projectId: string } & Partial<
    Pick<ProjectRecord, 'description' | 'artifactBackend' | 'visibility'>
  >,
): Promise<ProjectRecord> {
  return (await first<ProjectRecord>(
    connection,
    `UPDATE projects AS p SET description=COALESCE($2,description),
      artifact_backend=COALESCE($3,artifact_backend),visibility=COALESCE($4,visibility)
    WHERE id=$1 RETURNING ${PROJECT_COLUMNS}`,
    [change.projectId, change.description, change.artifactBackend, change.visibility],
  ))!;
}

export interface ProjectLifecycle {
  id: string;
  name: string;
  archivedAt: string | null;
}

/**
 * Locks a Project that has not been purged, archived or not, for an archive, restore or purge.
 * A purged Project is gone for every caller.
 */
export async function lockProjectLifecycle(
  connection: Connection,
  projectId: string,
): Promise<ProjectLifecycle | undefined> {
  return first<ProjectLifecycle>(
    connection,
    'SELECT id,name,archived_at FROM projects WHERE id=$1 AND purged_at IS NULL FOR UPDATE',
    [projectId],
  );
}

/**
 * Holds a live Project until the transaction ends, so creating a Job and archiving the Project
 * serialize: the archive then sees the Job (and refuses), or the Job sees the archive.
 */
export async function shareLiveProject(
  connection: Connection,
  projectId: string,
): Promise<boolean> {
  const live = await first(
    connection,
    'SELECT id FROM projects WHERE id=$1 AND archived_at IS NULL FOR SHARE',
    [projectId],
  );
  return !!live;
}

/**
 * Whether a Job of the Project is waiting or running (queued, claimed or running), or was canceled
 * while still in a site's scheduler queue and the launcher has not removed it there yet: the
 * launcher finds that queue entry through the Job's row, which a purge would delete.
 */
export async function hasActiveJobs(connection: Connection, projectId: string): Promise<boolean> {
  const active = await first(
    connection,
    `SELECT 1 FROM jobs WHERE project_id=$1
    AND (status IN ('queued','claimed','running') OR scheduler_cancel_state='pending') LIMIT 1`,
    [projectId],
  );
  return !!active;
}

export async function archiveProject(
  connection: Connection,
  archive: { projectId: string; archivedBy: string },
): Promise<void> {
  await connection.query('UPDATE projects SET archived_at=now(),archived_by=$2 WHERE id=$1', [
    archive.projectId,
    archive.archivedBy,
  ]);
}

export async function unarchiveProject(connection: Connection, projectId: string): Promise<void> {
  await connection.query('UPDATE projects SET archived_at=NULL,archived_by=NULL WHERE id=$1', [
    projectId,
  ]);
}

/** Turns an archived Project into its tombstone: only the id and the name stay. */
export async function markProjectPurged(
  connection: Connection,
  purge: { projectId: string; purgedBy: string },
): Promise<void> {
  await connection.query(
    "UPDATE projects SET purged_at=now(),purged_by=$2,description='' WHERE id=$1",
    [purge.projectId, purge.purgedBy],
  );
}

// Members are direct grants and group bindings (project_membership_roles), never public access;
// Runs deleted through MLflow are not counted.
const adminProjectSelect = `SELECT ${PROJECT_COLUMNS},p.archived_at,
  (SELECT count(*)::int FROM project_membership_roles m WHERE m.project_id=p.id) AS member_count,
  (SELECT count(*)::int FROM runs r WHERE r.project_id=p.id AND r.lifecycle_stage='active') AS run_count
  FROM projects p`;

export async function listAdminProjects(
  connection: Connection,
  query: { includeArchived: boolean },
): Promise<AdminProject[]> {
  return rows<AdminProject>(
    connection,
    `${adminProjectSelect} WHERE p.purged_at IS NULL AND ($1 OR p.archived_at IS NULL)
    ORDER BY p.created_at DESC,p.id`,
    [query.includeArchived],
  );
}

export async function findAdminProject(
  connection: Connection,
  projectId: string,
): Promise<AdminProject | undefined> {
  return first<AdminProject>(
    connection,
    `${adminProjectSelect} WHERE p.id=$1 AND p.purged_at IS NULL`,
    [projectId],
  );
}

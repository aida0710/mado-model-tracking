import type { SavedView, SavedViewPage, SavedViewState, SavedViewVisibility } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

const savedViewSelect = `SELECT id,project_id,owner_user_id,visibility,page,name,state,created_at,updated_at
  FROM saved_views`;

/** PostgreSQL unique_violation: a view of the same name exists for the owner or the Project. */
const UNIQUE_VIOLATION = '23505';

export function isSavedViewNameConflict(error: unknown): boolean {
  return (error as { code?: string }).code === UNIQUE_VIOLATION;
}

export async function findSavedView(
  connection: Connection,
  view: { projectId: string; savedViewId: string; lock?: boolean },
): Promise<SavedView | undefined> {
  return first<SavedView>(
    connection,
    `${savedViewSelect} WHERE id=$1 AND project_id=$2 ${view.lock ? 'FOR UPDATE' : ''}`,
    [view.savedViewId, view.projectId],
  );
}

/** The viewer's own views (private and shared) and every view shared with the Project. */
export async function listVisibleSavedViews(
  connection: Connection,
  query: { projectId: string; page: SavedViewPage; viewerUserId: string },
): Promise<SavedView[]> {
  return rows<SavedView>(
    connection,
    `${savedViewSelect} WHERE project_id=$1 AND page=$2 AND (visibility='project' OR owner_user_id=$3)
    ORDER BY name,id`,
    [query.projectId, query.page, query.viewerUserId],
  );
}

export async function insertSavedView(
  connection: Connection,
  view: {
    projectId: string;
    ownerUserId: string;
    visibility: SavedViewVisibility;
    page: SavedViewPage;
    name: string;
    state: SavedViewState;
  },
): Promise<SavedView> {
  return (await first<SavedView>(
    connection,
    `INSERT INTO saved_views(project_id,owner_user_id,visibility,page,name,state)
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING id,project_id,owner_user_id,visibility,page,name,state,created_at,updated_at`,
    [view.projectId, view.ownerUserId, view.visibility, view.page, view.name, view.state],
  ))!;
}

export async function updateSavedView(
  connection: Connection,
  view: {
    savedViewId: string;
    name: string;
    state: SavedViewState;
    visibility: SavedViewVisibility;
  },
): Promise<SavedView> {
  return (await first<SavedView>(
    connection,
    `UPDATE saved_views SET name=$2,state=$3,visibility=$4,updated_at=now() WHERE id=$1
    RETURNING id,project_id,owner_user_id,visibility,page,name,state,created_at,updated_at`,
    [view.savedViewId, view.name, view.state, view.visibility],
  ))!;
}

export async function deleteSavedView(connection: Connection, savedViewId: string): Promise<void> {
  await connection.query('DELETE FROM saved_views WHERE id=$1', [savedViewId]);
}

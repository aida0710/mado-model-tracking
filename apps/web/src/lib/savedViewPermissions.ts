import type { ProjectRole, SavedView, SavedViewVisibility } from '@mmt/contracts';
import { canEditProject, canManageProject } from './permissions';

// Mirrors savedViewService on the API so the menu hides what the API would refuse with 403.
// A global administrator who is not a member resolves to admin in `role`.

export interface SavedViewActor {
  userId: string;
  role: ProjectRole;
}

/** Sharing with the Project needs the editor role; anyone may keep a view for themselves. */
export function savedViewVisibilityChoices(role: ProjectRole): SavedViewVisibility[] {
  return canEditProject(role) ? ['private', 'project'] : ['private'];
}

/** Overwriting the state and renaming: the owner, or a Project admin for a shared view. */
export function canChangeSavedView(view: SavedView, actor: SavedViewActor): boolean {
  if (view.ownerUserId === actor.userId)
    return view.visibility === 'private' || canEditProject(actor.role);
  return view.visibility === 'project' && canManageProject(actor.role);
}

/** Only the owner changes who sees a view; a Project admin may rename it but not hide it. */
export function canChangeSavedViewVisibility(view: SavedView, actor: SavedViewActor): boolean {
  return view.ownerUserId === actor.userId;
}

/** The owner whatever their role, or a Project admin for a shared view. */
export function canDeleteSavedView(view: SavedView, actor: SavedViewActor): boolean {
  return (
    view.ownerUserId === actor.userId ||
    (view.visibility === 'project' && canManageProject(actor.role))
  );
}

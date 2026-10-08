import type { SavedView, SavedViewPage, SavedViewState } from '@mmt/contracts';
import { savedViewsApi } from '../api/savedViews';
import { RequestError } from '../api/http';
import { parseSavedViewState } from '../lib/savedViewState';
import { useQuery } from './useQuery';

/** Why a view in the URL cannot be shown; the list then opens with its default display. */
export type SavedViewUnavailableReason = 'not_found' | 'unsupported_version' | 'invalid';

export type OpenedSavedView =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; view: SavedView; state: SavedViewState }
  | { status: 'unavailable'; reason: SavedViewUnavailableReason }
  | { status: 'error'; message: string };

type OpenResult = Exclude<OpenedSavedView, { status: 'none' | 'loading' | 'error' }>;

async function openSavedView(
  projectId: string,
  viewId: string,
  signal: AbortSignal,
): Promise<OpenResult> {
  try {
    const view = await savedViewsApi.get(projectId, viewId, signal);
    const parsed = parseSavedViewState(view.state);
    return parsed.ok
      ? { status: 'ready', view, state: parsed.state }
      : { status: 'unavailable', reason: parsed.reason };
  } catch (failure) {
    // Another user's private view answers 404 like a deleted one, so the two read the same.
    if (failure instanceof RequestError && failure.status === 404)
      return { status: 'unavailable', reason: 'not_found' };
    throw failure;
  }
}

/** The views listed for a page, and the view named in the URL (`viewId`, empty for none). */
export function useSavedViews(projectId: string, page: SavedViewPage, viewId: string) {
  const views = useQuery(`${projectId}:saved-views:${page}`, (signal) =>
    savedViewsApi.list(projectId, page, signal),
  );
  const openQuery = useQuery(viewId ? `${projectId}:saved-view:${viewId}` : null, (signal) =>
    openSavedView(projectId, viewId, signal),
  );
  const opened: OpenedSavedView = !viewId
    ? { status: 'none' }
    : openQuery.error
      ? { status: 'error', message: openQuery.error }
      : (openQuery.value ?? { status: 'loading' });
  return { views, opened, reloadOpened: openQuery.reload };
}

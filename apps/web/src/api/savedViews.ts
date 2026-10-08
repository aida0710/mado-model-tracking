import type { SavedView, SavedViewCreate, SavedViewPage, SavedViewPatch } from '@mmt/contracts';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

const savedViewsPath = (projectId: string) => `${projectPath(projectId)}/saved-views`;
const savedViewPath = (projectId: string, viewId: string) =>
  `${savedViewsPath(projectId)}/${encodeId(viewId)}`;

export const savedViewsApi = {
  /** The caller's private views and every shared view of the page. */
  list: (projectId: string, page: SavedViewPage, signal?: AbortSignal) =>
    requestItems<SavedView>(
      `${savedViewsPath(projectId)}?${new URLSearchParams({ page })}`,
      signal,
    ),
  get: (projectId: string, viewId: string, signal?: AbortSignal) =>
    request<SavedView>(savedViewPath(projectId, viewId), { signal }),
  create: (projectId: string, body: SavedViewCreate) =>
    request<SavedView>(savedViewsPath(projectId), jsonRequest('POST', body)),
  update: (projectId: string, viewId: string, body: SavedViewPatch) =>
    request<SavedView>(savedViewPath(projectId, viewId), jsonRequest('PATCH', body)),
  remove: (projectId: string, viewId: string) =>
    request<void>(savedViewPath(projectId, viewId), { method: 'DELETE' }),
};

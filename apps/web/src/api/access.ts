import type {
  ProjectGroupBinding,
  ProjectMember,
  ProjectRole,
  UserSearchResult,
} from '@mmt/contracts';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

const memberPath = (projectId: string, userId?: string) =>
  `${projectPath(projectId)}/members${userId ? `/${encodeId(userId)}` : ''}`;
const groupBindingPath = (projectId: string, group?: string) =>
  `${projectPath(projectId)}/group-bindings${group ? `/${encodeId(group)}` : ''}`;

/** Who may use a Project: direct members, Authentik group bindings, and the lookups behind them. */
export const accessApi = {
  members: (projectId: string, signal?: AbortSignal) =>
    requestItems<ProjectMember>(memberPath(projectId), signal),
  saveMember: (projectId: string, userId: string, role: ProjectRole) =>
    request<unknown>(memberPath(projectId, userId), jsonRequest('PUT', { role })),
  removeMember: (projectId: string, userId: string) =>
    request<unknown>(memberPath(projectId, userId), { method: 'DELETE' }),
  groupBindings: (projectId: string, signal?: AbortSignal) =>
    requestItems<ProjectGroupBinding>(groupBindingPath(projectId), signal),
  saveGroupBinding: (projectId: string, group: string, role: ProjectRole) =>
    request<ProjectGroupBinding>(groupBindingPath(projectId, group), jsonRequest('PUT', { role })),
  removeGroupBinding: (projectId: string, group: string) =>
    request<unknown>(groupBindingPath(projectId, group), { method: 'DELETE' }),
  searchUsers: (query: string, signal?: AbortSignal) =>
    requestItems<UserSearchResult>(`/users?${new URLSearchParams({ query })}`, signal),
  /** Group names already seen on users, offered as candidates when adding a binding. */
  groups: (signal?: AbortSignal) => requestItems<string>('/auth/groups', signal),
};

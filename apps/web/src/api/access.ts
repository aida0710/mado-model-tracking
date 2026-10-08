import type {
  ProjectGroupBinding,
  ProjectMember,
  ProjectRole,
  ServiceAccount,
  ServiceAccountCreate,
  ServiceAccountTokenCreate,
  ServiceAccountUpdate,
  TokenSummary,
  UserSearchResult,
} from '@mmt/contracts';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

const memberPath = (projectId: string, userId?: string) =>
  `${projectPath(projectId)}/members${userId ? `/${encodeId(userId)}` : ''}`;
const serviceAccountPath = (projectId: string, serviceAccountId?: string) =>
  `${projectPath(projectId)}/service-accounts${serviceAccountId ? `/${encodeId(serviceAccountId)}` : ''}`;
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
  serviceAccounts: (projectId: string, signal?: AbortSignal) =>
    requestItems<ServiceAccount>(serviceAccountPath(projectId), signal),
  createServiceAccount: (projectId: string, body: ServiceAccountCreate) =>
    request<ServiceAccount>(serviceAccountPath(projectId), jsonRequest('POST', body)),
  updateServiceAccount: (projectId: string, serviceAccountId: string, body: ServiceAccountUpdate) =>
    request<ServiceAccount>(
      serviceAccountPath(projectId, serviceAccountId),
      jsonRequest('PATCH', body),
    ),
  createServiceAccountToken: (
    projectId: string,
    serviceAccountId: string,
    body: ServiceAccountTokenCreate,
  ) =>
    request<{ token: string; item: TokenSummary }>(
      `${serviceAccountPath(projectId, serviceAccountId)}/tokens`,
      jsonRequest('POST', body),
    ),
  /** Every token limited to the Project, whoever owns it. Values are never returned. */
  projectTokens: (projectId: string, signal?: AbortSignal) =>
    requestItems<TokenSummary>(`${projectPath(projectId)}/tokens`, signal),
};

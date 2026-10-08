import type {
  AdminUser,
  AdminUserCreate,
  AdminUserPasswordReset,
  AdminUserPatch,
  AdminUserQuery,
} from '@mmt/contracts';
import { encodeId, invalidResponseError, jsonRequest, request, requestItems } from './http';

const userPath = (userId?: string) =>
  `/admin/users${userId === undefined ? '' : `/${encodeId(userId)}`}`;

function searchParameters(query: AdminUserQuery): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) parameters.set(key, value);
  const encoded = parameters.toString();
  return encoded ? `?${encoded}` : '';
}

/** The global administrator's user management (/admin/users). */
export const adminUsersApi = {
  list: (query: AdminUserQuery, signal?: AbortSignal) =>
    requestItems<AdminUser>(`${userPath()}${searchParameters(query)}`, signal),
  create: (body: AdminUserCreate) => request<AdminUser>(userPath(), jsonRequest('POST', body)),
  update: (userId: string, body: AdminUserPatch) =>
    request<AdminUser>(userPath(userId), jsonRequest('PATCH', body)),
  resetPassword: async (userId: string) => {
    const payload = await request<AdminUserPasswordReset>(`${userPath(userId)}/reset-password`, {
      method: 'POST',
    });
    if (typeof payload.temporaryPassword !== 'string') throw invalidResponseError();
    return payload;
  },
};

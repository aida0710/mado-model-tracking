import type { AuthConfig, AuthMe, User } from '@mmt/contracts';
import { jsonRequest, request } from './http';

export const authApi = {
  config: (signal?: AbortSignal) => request<AuthConfig>('/auth/config', { signal }),
  me: (signal?: AbortSignal) => request<AuthMe>('/auth/me', { signal }),
  devLogin: (email: string, displayName: string) =>
    request<{ user: User }>('/auth/dev-login', jsonRequest('POST', { email, displayName })),
  localLogin: (credentials: { username: string; password: string }) =>
    request<AuthMe>('/auth/local-login', jsonRequest('POST', credentials)),
  changePassword: (passwords: { currentPassword: string; newPassword: string }) =>
    request<void>('/auth/change-password', jsonRequest('POST', passwords)),
  logout: () => request<unknown>('/auth/logout', { method: 'POST' }),
};

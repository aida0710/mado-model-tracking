import type { Account } from '@mmt/contracts';
import { invalidResponseError, request } from './http';

/** The signed-in user's own profile (/account). */
export const accountApi = {
  get: async (signal?: AbortSignal) => {
    const payload = await request<Account>('/account', { signal });
    if (!payload.user || !Array.isArray(payload.groups)) throw invalidResponseError();
    return payload;
  },
};

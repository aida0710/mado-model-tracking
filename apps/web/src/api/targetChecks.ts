import type { TargetCheck } from '@mmt/contracts';
import { encodeId, request, requestItems } from './http';

const checksPath = (targetId: string) => `/targets/${encodeId(targetId)}/checks`;

// Connection checks are global-administrator operations; the API answers 403 to others.
export const targetChecksApi = {
  list: (targetId: string, signal?: AbortSignal) =>
    requestItems<TargetCheck>(checksPath(targetId), signal),
  request: (targetId: string) => request<TargetCheck>(checksPath(targetId), { method: 'POST' }),
};

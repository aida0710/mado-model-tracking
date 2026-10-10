import type { Launcher, LauncherCreate, LauncherCreated } from '@mmt/contracts';
import { encodeId, invalidResponseError, jsonRequest, request, requestItems } from './http';

const launcherPath = (launcherId: string) => `/launchers/${encodeId(launcherId)}`;

/** A launcher's new token. It is shown once, so an answer without it is a contract break. */
async function issueToken(path: string, init: RequestInit): Promise<LauncherCreated> {
  const created = await request<LauncherCreated>(path, init);
  if (typeof created.token !== 'string' || typeof created.launcher?.id !== 'string')
    throw invalidResponseError(201);
  return created;
}

// Launchers are registered by global administrators; anyone signed in may list the live ones to
// choose the launcher of a computer.
export const launchersApi = {
  list: (signal?: AbortSignal) => requestItems<Launcher>('/launchers', signal),
  create: (body: LauncherCreate) => issueToken('/launchers', jsonRequest('POST', body)),
  /** Replaces the token; the old one stops working at once. */
  rotateToken: (launcherId: string) =>
    issueToken(`${launcherPath(launcherId)}/token`, { method: 'POST' }),
  /** Revokes the launcher and its token. */
  revoke: (launcherId: string) => request<void>(launcherPath(launcherId), { method: 'DELETE' }),
};

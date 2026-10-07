import type { ApiError } from '@mmt/contracts';
import { text } from '../i18n/catalog';

export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...options, credentials: 'include' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RequestError(text.requestError, 0);
  }
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError = payload as Partial<ApiError> | null;
    throw new RequestError(
      typeof apiError?.error === 'string'
        ? apiError.error
        : `${text.requestError} (${response.status})`,
      response.status,
      apiError?.code,
    );
  }
  if (payload === null) throw new RequestError(text.invalidResponse, response.status);
  return payload as T;
}

export async function requestItems<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const payload = await request<{ items: T[] }>(path, { signal });
  if (!Array.isArray(payload.items)) throw new RequestError(text.invalidResponse, 200);
  return payload.items;
}

export function jsonRequest(method: 'POST' | 'PATCH' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const encodeId = encodeURIComponent;
export const projectPath = (projectId: string) => `/projects/${encodeId(projectId)}`;

import { hooksApi } from '../api/hooks';
import { useCursorPages } from './useCursorPages';
import { useQuery } from './useQuery';

/** The Project's hooks, newest first. */
export function useHookList(projectId: string) {
  return useQuery(`${projectId}:hooks`, (signal) => hooksApi.list(projectId, signal));
}

/**
 * Executions of one hook, or of every hook when hookId is empty, read page by page. Nothing is
 * requested while `enabled` is false (the executions tab is not shown).
 */
export function useHookExecutions(projectId: string, { hookId, enabled }: { hookId: string; enabled: boolean }) {
  return useCursorPages(
    enabled ? `${projectId}:hook-executions:${hookId}` : null,
    (cursor, signal) =>
      hooksApi.executions(projectId, { hookId: hookId || undefined, cursor }, signal),
  );
}

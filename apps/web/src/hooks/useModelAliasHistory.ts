import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelAliasEvent } from '@mmt/contracts';
import { registryApi } from '../api/registry';
import { formatErrorMessage } from '../lib/errorMessage';

export interface ModelAliasHistoryState {
  items: ModelAliasEvent[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
}

// Pages through one Model's alias events, newest first. Pass modelId null when no Model is selected.
export function useModelAliasHistory(
  projectId: string,
  modelId: string | null,
): ModelAliasHistoryState {
  const [items, setItems] = useState<ModelAliasEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Aborts the in-flight page when the Model changes or the history is reloaded.
  const controllerRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (cursor: string | undefined) => {
      if (!modelId) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const page = await registryApi.aliasEvents(projectId, modelId, {
          cursor,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setItems((previous) => (cursor ? [...previous, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (failure) {
        if (!controller.signal.aborted) setError(formatErrorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [projectId, modelId],
  );

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    void loadPage(undefined);
    return () => controllerRef.current?.abort();
  }, [loadPage, revision]);

  return {
    items,
    hasMore: nextCursor !== null,
    loading,
    error,
    loadMore: () => {
      if (nextCursor && !loading) void loadPage(nextCursor);
    },
    reload: () => setRevision((value) => value + 1),
  };
}

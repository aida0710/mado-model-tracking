import { useCallback, useEffect, useRef, useState } from 'react';
import { formatErrorMessage } from '../lib/errorMessage';

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface CursorPagesState<T> {
  items: T[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Reads the first page for a key and appends later pages on demand. A new key starts over, so
 * the key must cover every filter the loader uses. Pass null to send no request.
 */
export function useCursorPages<T>(
  key: string | null,
  loadPage: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>,
): CursorPagesState<T> {
  const loaderRef = useRef(loadPage);
  loaderRef.current = loadPage;
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Aborts the in-flight page when the key changes or the list is reloaded.
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (cursor: string | undefined) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const page = await loaderRef.current(cursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((previous) => (cursor ? [...previous, ...page.items] : page.items));
      setNextCursor(page.nextCursor ?? null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(formatErrorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    if (!key) {
      setLoading(false);
      return;
    }
    void load(undefined);
    return () => controllerRef.current?.abort();
  }, [key, load, revision]);

  return {
    items,
    hasMore: nextCursor !== null,
    loading,
    error,
    loadMore: () => {
      if (nextCursor && !loading) void load(nextCursor);
    },
    reload: () => setRevision((value) => value + 1),
  };
}

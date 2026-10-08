import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEvent } from '@mmt/contracts';
import { auditApi } from '../api/audit';

/** Whose events to read: one Project's log, or the global log of global administrators. */
export type AuditEventScope = { projectId: string } | 'global';

export interface AuditEventsState {
  items: AuditEvent[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Pass null when the viewer may not read the log so no request is sent.
export function useAuditEvents(scope: AuditEventScope | null): AuditEventsState {
  // A string key so a new scope object with the same Project does not refetch.
  const scopeKey = scope === null ? null : scope === 'global' ? 'global' : scope.projectId;
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Aborts the in-flight page when the scope changes or the list is reloaded.
  const controllerRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (cursor: string | undefined) => {
      if (scopeKey === null) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const request = { cursor, signal: controller.signal };
        const page =
          scopeKey === 'global'
            ? await auditApi.globalEvents(request)
            : await auditApi.projectEvents(scopeKey, request);
        if (controller.signal.aborted) return;
        setItems((previous) => (cursor ? [...previous, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [scopeKey],
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

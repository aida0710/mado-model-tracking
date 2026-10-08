import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromotionEvaluation } from '@mmt/contracts';
import { promotionApi } from '../api/promotion';
import { formatErrorMessage } from '../lib/errorMessage';
import { useMutation } from './useMutation';

export interface PromotionEvaluationsState {
  items: PromotionEvaluation[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
  reevaluate: (evaluationId: string) => Promise<void>;
  reevaluating: boolean;
  reevaluateError: string | null;
}

// Pages through one policy's evaluations, newest first. Pass policyId null when none is selected.
export function usePromotionEvaluations(
  projectId: string,
  policyId: string | null,
): PromotionEvaluationsState {
  const [items, setItems] = useState<PromotionEvaluation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const mutation = useMutation();
  // Aborts the in-flight page when the policy changes or the history is reloaded.
  const controllerRef = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (cursor: string | undefined) => {
      if (!policyId) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const page = await promotionApi.evaluations(projectId, {
          policyId,
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
    [projectId, policyId],
  );

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    void loadPage(undefined);
    return () => controllerRef.current?.abort();
  }, [loadPage, revision]);

  const reload = () => setRevision((value) => value + 1);
  // A re-evaluation appends a new row, so the first page is fetched again to show it on top.
  async function reevaluate(evaluationId: string) {
    const created = await mutation.run(() => promotionApi.reevaluate(projectId, evaluationId));
    if (created) reload();
  }
  return {
    items,
    hasMore: nextCursor !== null,
    loading,
    error,
    loadMore: () => {
      if (nextCursor && !loading) void loadPage(nextCursor);
    },
    reload,
    reevaluate,
    reevaluating: mutation.pending,
    reevaluateError: mutation.error,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueryState<T> {
  value: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}
// Keep active Run and job views current without making idle registry pages poll.
export const EXECUTION_POLL_MS = 5000;

export function useQuery<T>(
  key: string | null,
  loader: (signal: AbortSignal) => Promise<T>,
  pollMs?: number,
): QueryState<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    value?: T;
    loading: boolean;
    error: string | null;
  }>({ key: null, loading: true, error: null });
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!key) {
      setState({ key, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({
      key,
      value: previous.key === key ? previous.value : undefined,
      loading: true,
      error: null,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const value = await loaderRef.current(controller.signal);
        if (!controller.signal.aborted) setState({ key, value, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            key,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      }
      if (!controller.signal.aborted && pollMs) timer = setTimeout(load, pollMs);
    }
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [key, revision, pollMs]);
  return {
    value: state.key === key ? state.value : undefined,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : null,
    reload,
  };
}

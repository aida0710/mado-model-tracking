import { useEffect, useRef, useState } from 'react';
import { EXECUTION_POLL_MS, useQuery, type QueryState } from './useQuery';

/**
 * useQuery that polls only while the latest value still has work in progress, so a page left
 * open on finished results stops sending requests. A reload that brings new work resumes polling.
 */
export function useQueryPolledWhileActive<T>(
  key: string | null,
  loader: (signal: AbortSignal) => Promise<T>,
  isActive: (value: T) => boolean,
): QueryState<T> {
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const [isPolling, setPolling] = useState(true);
  const query = useQuery(key, loader, isPolling ? EXECUTION_POLL_MS : undefined);
  const { value } = query;
  useEffect(() => {
    if (value !== undefined) setPolling(isActiveRef.current(value));
  }, [value]);
  return query;
}

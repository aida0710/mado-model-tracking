import { useEffect, useRef, useState } from 'react';
import { formatErrorMessage } from '../lib/errorMessage';

export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);
  const isRunning = useRef(false);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (isRunning.current) return undefined;
    isRunning.current = true;
    setPending(true);
    setError(null);
    try {
      return await operation();
    } catch (failure) {
      if (isMounted.current) setError(formatErrorMessage(failure));
      return undefined;
    } finally {
      isRunning.current = false;
      if (isMounted.current) setPending(false);
    }
  }
  return { run, pending, error, clearError: () => setError(null) };
}

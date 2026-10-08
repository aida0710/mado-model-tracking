import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether the media query matches now, updated when the window crosses it. Without matchMedia
 * (server rendering, tests) it reports false, the wide layout.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const matches = () =>
    typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, matches, () => false);
}

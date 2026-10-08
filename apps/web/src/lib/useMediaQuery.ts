import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether the media query matches, kept current as the window resizes. Without a window (server
 * rendering in tests) it reports false, so wide layouts are the default.
 */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

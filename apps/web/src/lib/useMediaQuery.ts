import { useSyncExternalStore } from 'react';

/** Whether the media query matches now, kept current as the viewport changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    // Server rendering and tests have no viewport; the wide layout shows every column.
    () => false,
  );
}

import { useCallback, useSyncExternalStore } from 'react';

/** The width breakpoints of styles/breakpoints.css (--bp-sm / --bp-md / --bp-lg), in CSS pixels. */
export const BREAKPOINTS = { sm: 640, md: 900, lg: 1200 } as const;
export type Breakpoint = keyof typeof BREAKPOINTS;

/** The media query that matches widths below `breakpoint`, as the stylesheets write it. */
export function narrowerThan(breakpoint: Breakpoint): string {
  return `(width < ${BREAKPOINTS[breakpoint]}px)`;
}

/**
 * Whether `query` matches now, kept current as the window resizes. Without `matchMedia` (server
 * rendering, tests) it reports false, so the wide layout is the default.
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
  const matches = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, matches, () => false);
}

/** Whether the window is narrower than `breakpoint` (the layouts switch to one column below md). */
export function useIsNarrow(breakpoint: Breakpoint = 'md'): boolean {
  return useMediaQuery(narrowerThan(breakpoint));
}

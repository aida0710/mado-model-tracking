/** The widths in styles/breakpoints.css (--bp-sm/--bp-md/--bp-lg); keep both files in step. */
export const BREAKPOINT_PX = { sm: 640, md: 900, lg: 1200 } as const;

export type Breakpoint = keyof typeof BREAKPOINT_PX;

/** The media query that matches widths at or below the breakpoint, as the CSS rules write it. */
export function maxWidthQuery(breakpoint: Breakpoint): string {
  return `(max-width: ${BREAKPOINT_PX[breakpoint]}px)`;
}

/** Below --bp-md the registry list and detail stack, and tables keep only their primary columns. */
export const NARROW_QUERY = maxWidthQuery('md');

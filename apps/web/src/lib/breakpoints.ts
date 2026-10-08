/**
 * The width breakpoints defined as --bp-sm / --bp-md / --bp-lg in styles/breakpoints.css, for code
 * that has to branch on width. Keep both in step; breakpoints.test.ts compares them.
 */
export const BREAKPOINT_PX = {
  sm: 640,
  md: 900,
  lg: 1200,
} as const;

export type Breakpoint = keyof typeof BREAKPOINT_PX;

/** The media query that matches while the viewport is narrower than `breakpoint`. */
export function narrowerThan(breakpoint: Breakpoint) {
  return `(width < ${BREAKPOINT_PX[breakpoint]}px)`;
}

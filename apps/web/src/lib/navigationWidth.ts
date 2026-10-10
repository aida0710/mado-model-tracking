/** Widths of the full navigation sidebar the user can drag between, in CSS pixels. */
export const NAVIGATION_WIDTH = {
  default: 192,
  min: 160,
  max: 360,
  /** One press of an arrow key on the resize handle. */
  keyboardStep: 16,
} as const;

/** Keeps a dragged or stored width inside the sidebar's limits, in whole pixels. */
export function clampNavigationWidth(width: number): number {
  return Math.round(Math.min(NAVIGATION_WIDTH.max, Math.max(NAVIGATION_WIDTH.min, width)));
}

/** The width saved by an earlier resize, or the default when nothing valid was saved. */
export function storedNavigationWidth(raw: string | null): number {
  const width = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(width) ? clampNavigationWidth(width) : NAVIGATION_WIDTH.default;
}

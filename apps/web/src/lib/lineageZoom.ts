/** Zoom of the lineage diagram: 1 draws nodes at their layout size. */
// Below this the node labels are no longer legible even as an overview.
export const LINEAGE_MIN_ZOOM = 0.25;
// Above this nodes are larger than the page text; more zoom only adds scrolling.
export const LINEAGE_MAX_ZOOM = 2;
// Node labels stay readable from here; a narrow window opens at this size and pans for the rest.
export const LINEAGE_READABLE_ZOOM = 0.5;
// One press of the zoom buttons; five presses double or halve the size.
const LINEAGE_ZOOM_STEP = 1.15;

export function clampLineageZoom(zoom: number): number {
  return Math.min(LINEAGE_MAX_ZOOM, Math.max(LINEAGE_MIN_ZOOM, zoom));
}

/** The zoom that fits the whole diagram width into the viewport, never enlarging it. */
export function fitLineageZoom(viewportWidth: number, diagramWidth: number): number {
  if (viewportWidth <= 0 || diagramWidth <= 0) return 1;
  return clampLineageZoom(Math.min(1, viewportWidth / diagramWidth));
}

/** The first zoom on a narrow window: the whole width if it stays readable, otherwise readable. */
export function openingLineageZoom(viewportWidth: number, diagramWidth: number): number {
  return Math.max(LINEAGE_READABLE_ZOOM, fitLineageZoom(viewportWidth, diagramWidth));
}

export function stepLineageZoom(zoom: number, direction: 'in' | 'out'): number {
  return clampLineageZoom(direction === 'in' ? zoom * LINEAGE_ZOOM_STEP : zoom / LINEAGE_ZOOM_STEP);
}

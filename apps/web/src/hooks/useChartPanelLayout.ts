import { useCallback, useRef, useState } from 'react';
import type { ChartPanelLayout } from '@mmt/contracts';
import { parseChartPanelLayout } from '../lib/chartPanelLayout';

// The chart panels a user arranged, per Project and page, kept in this browser. Viewers arrange
// charts too, so the layout is the user's own and not written to the server.
const CHART_LAYOUT_STORAGE_PREFIX = 'mmt.chartPanels.v1';

/** The pages with their own panel arrangement. */
export type ChartLayoutPage = 'runDetail' | 'compare' | 'runList';

const storageKey = (projectId: string, page: ChartLayoutPage) =>
  `${CHART_LAYOUT_STORAGE_PREFIX}:${projectId}:${page}`;

function readStoredLayout(key: string): ChartPanelLayout | null {
  try {
    const stored = window.localStorage.getItem(key);
    // A broken or outdated value falls back to the default instead of failing the page.
    return stored ? parseChartPanelLayout(JSON.parse(stored)) : null;
  } catch {
    return null;
  }
}

function writeStoredLayout(key: string, layout: ChartPanelLayout | null) {
  try {
    if (layout) window.localStorage.setItem(key, JSON.stringify(layout));
    else window.localStorage.removeItem(key);
  } catch {
    // Without storage (private window, quota) the arrangement lasts until the page is left.
  }
}

/**
 * The stored layout, or `defaultLayout` until the user changes something. The default follows the
 * metrics the page currently has, so it is not stored until the user arranges the panels.
 */
export function useChartPanelLayout(
  projectId: string,
  page: ChartLayoutPage,
  defaultLayout: ChartPanelLayout,
) {
  const key = storageKey(projectId, page);
  const [stored, setStored] = useState(() => ({ key, layout: readStoredLayout(key) }));
  if (stored.key !== key) setStored({ key, layout: readStoredLayout(key) });
  const layout = (stored.key === key ? stored.layout : null) ?? defaultLayout;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const updateLayout = useCallback(
    (change: (layout: ChartPanelLayout) => ChartPanelLayout) => {
      const next = change(layoutRef.current);
      layoutRef.current = next;
      writeStoredLayout(key, next);
      setStored({ key, layout: next });
    },
    [key],
  );
  const resetLayout = useCallback(() => {
    writeStoredLayout(key, null);
    setStored({ key, layout: null });
  }, [key]);
  return {
    layout,
    isCustomized: stored.key === key && stored.layout !== null,
    updateLayout,
    resetLayout,
  };
}

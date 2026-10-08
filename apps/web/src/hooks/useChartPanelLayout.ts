import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ChartPanelLayout } from '@mmt/contracts';
import { parseChartPanelLayout } from '../lib/chartPanelLayout';

// The chart panels a user arranged, per Project and page, kept in this browser. Viewers arrange
// charts too, so the layout is the user's own; it reaches the server only inside a saved view.
const CHART_LAYOUT_STORAGE_PREFIX = 'mmt.chartPanels.v1';

/** The pages with their own panel arrangement. */
export type ChartLayoutPage = 'runDetail' | 'compare' | 'runList';

const storageKey = (projectId: string, page: ChartLayoutPage) =>
  `${CHART_LAYOUT_STORAGE_PREFIX}:${projectId}:${page}`;

/**
 * A layout the page holds instead of this browser's storage: the open saved view of the Run
 * list, whose changes stay unsaved until the view is saved. `null` shows the default layout.
 */
export interface ChartPanelLayoutSource {
  layout: ChartPanelLayout | null;
  onChange: (layout: ChartPanelLayout | null) => void;
}
export const ChartPanelLayoutSourceContext = createContext<ChartPanelLayoutSource | null>(null);

/** The arrangement kept in this browser, as the page shows it when no saved view is open. */
export const readStoredChartPanelLayout = (projectId: string, page: ChartLayoutPage) =>
  readStoredLayout(storageKey(projectId, page));

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
 * Inside a ChartPanelLayoutSourceContext the source's layout is used and nothing is stored here.
 */
export function useChartPanelLayout(
  projectId: string,
  page: ChartLayoutPage,
  defaultLayout: ChartPanelLayout,
) {
  const source = useContext(ChartPanelLayoutSourceContext);
  const key = storageKey(projectId, page);
  const [stored, setStored] = useState(() => ({ key, layout: readStoredLayout(key) }));
  if (stored.key !== key) setStored({ key, layout: readStoredLayout(key) });
  const storedLayout = stored.key === key ? stored.layout : null;
  const chosenLayout = source ? source.layout : storedLayout;
  const layout = chosenLayout ?? defaultLayout;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const saveLayout = useCallback(
    (next: ChartPanelLayout | null) => {
      if (source) {
        source.onChange(next);
        return;
      }
      writeStoredLayout(key, next);
      setStored({ key, layout: next });
    },
    [key, source],
  );
  const updateLayout = useCallback(
    (change: (layout: ChartPanelLayout) => ChartPanelLayout) => {
      const next = change(layoutRef.current);
      layoutRef.current = next;
      saveLayout(next);
    },
    [saveLayout],
  );
  const resetLayout = useCallback(() => saveLayout(null), [saveLayout]);
  return {
    layout,
    isCustomized: chosenLayout !== null,
    updateLayout,
    resetLayout,
  };
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChartPanelLayout, SavedView, SavedViewColumn, SavedViewState } from '@mmt/contracts';
import { readStoredChartPanelLayout, type ChartPanelLayoutSource } from './useChartPanelLayout';
import { useSavedViews, type SavedViewUnavailableReason } from './useSavedViews';
import {
  hasUnsavedChanges,
  toRunListDisplay,
  toSavedViewState,
} from '../lib/savedViewState';
import { RUN_LIST_PARAMS, runListParamsForView, type RunListConditions } from '../lib/runListUrl';
import { text } from '../i18n/catalog';

const unavailableViewNotice: Record<SavedViewUnavailableReason, string> = {
  not_found: text.savedViewNotFound,
  unsupported_version: text.savedViewUnsupportedVersion,
  invalid: text.savedViewInvalid,
};

/**
 * The saved view open on the Run list (`?view=<id>`) and the display parts that live outside
 * the URL: columns and, while a view is open, its chart layout. Opening a view writes its
 * conditions to the URL; any later difference from the stored state is an unsaved change.
 */
export function useRunListSavedView({
  projectId,
  conditions,
  defaultColumns,
}: {
  projectId: string;
  conditions: RunListConditions;
  /** Shown while the user has not arranged the columns; follows the Runs on the page. */
  defaultColumns: SavedViewColumn[];
}) {
  const [params, setParams] = useSearchParams();
  const viewId = params.get(RUN_LIST_PARAMS.view) ?? '';
  const { views, opened } = useSavedViews(projectId, 'runs', viewId);
  const [customColumns, setCustomColumns] = useState<SavedViewColumn[] | null>(null);
  const [activeView, setActiveView] = useState<SavedView | null>(null);
  const [viewChartPanels, setViewChartPanels] = useState<ChartPanelLayout | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The view a save just put into the URL. The router applies the URL after the state, so until
  // then the URL still names the previous view (or none) and must not be followed.
  const savedViewIdRef = useRef<string | null>(null);
  const columns = customColumns ?? defaultColumns;

  function readCurrentState(): SavedViewState {
    return toSavedViewState({
      ...conditions,
      columns,
      chartPanels: activeView ? viewChartPanels : readStoredChartPanelLayout(projectId, 'runList'),
    });
  }
  const isChanged = activeView ? hasUnsavedChanges(activeView.state, readCurrentState()) : false;
  // Inside an open view the charts edit the view's layout, not this browser's stored one.
  const chartLayoutSource = useMemo<ChartPanelLayoutSource | null>(
    () => (activeView ? { layout: viewChartPanels, onChange: setViewChartPanels } : null),
    [activeView, viewChartPanels],
  );

  function applyView(view: SavedView, state: SavedViewState) {
    const display = toRunListDisplay(state);
    setParams(runListParamsForView(view.id, display), { replace: true });
    setCustomColumns(display.columns.length ? display.columns : null);
    setViewChartPanels(display.chartPanels);
    setActiveView(view);
  }
  function leaveView() {
    setActiveView(null);
    setCustomColumns(null);
    setViewChartPanels(null);
  }
  // Follows the URL: a newly loaded view is applied once, an unavailable one falls back to the
  // default display with a notice, and removing `?view=` (back button) leaves the view.
  useEffect(() => {
    if (savedViewIdRef.current !== null) {
      if (viewId !== savedViewIdRef.current) return;
      savedViewIdRef.current = null;
    }
    if (opened.status === 'ready' && activeView?.id !== opened.view.id) {
      setNotice(null);
      applyView(opened.view, opened.state);
    } else if (opened.status === 'unavailable') {
      setNotice(unavailableViewNotice[opened.reason]);
      leaveView();
      setParams(new URLSearchParams(), { replace: true });
    } else if (opened.status === 'none' && activeView) {
      leaveView();
    }
  });

  /** Opens a view, or the default display for null. Opening the open view drops its changes. */
  function openView(id: string | null) {
    setNotice(null);
    if (id && id === activeView?.id) {
      applyView(activeView, activeView.state);
      return;
    }
    setParams(id ? { [RUN_LIST_PARAMS.view]: id } : {});
  }
  /** After a save, rename or "save as": the list keeps what it shows under the stored view. */
  function finishSave(view: SavedView) {
    if (!activeView) {
      // Saved from the default display: keep exactly what was stored, not the moving defaults.
      setCustomColumns(columns);
      setViewChartPanels(toRunListDisplay(view.state).chartPanels);
    }
    setActiveView(view);
    savedViewIdRef.current = view.id;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(RUN_LIST_PARAMS.view, view.id);
      return next;
    });
  }

  return {
    views,
    openError: opened.status === 'error' ? opened.message : null,
    activeView,
    notice,
    columns,
    setColumns: setCustomColumns,
    isChanged,
    chartLayoutSource,
    readCurrentState,
    openView,
    finishSave,
  };
}

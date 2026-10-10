import { useEffect, useState } from 'react';
import type { ProjectRole } from '@mmt/contracts';
import { navigationGroups, type NavigationGroup } from '../layout/navigationLinks';
import { isGlobalAdmin } from '../lib/permissions';
import { narrowerThan } from '../lib/breakpoints';
import { useMediaQuery } from '../lib/useMediaQuery';
import { clampNavigationWidth, NAVIGATION_WIDTH, storedNavigationWidth } from '../lib/navigationWidth';
import { useAuth } from './useAuth';

// Below --bp-md the screen is too narrow for even the rail of icons, so a drawer holds the
// navigation; below --bp-lg the full sidebar would squeeze the runs table, so only the rail shows.
const DRAWER_QUERY = narrowerThan('md');
const RAIL_QUERY = narrowerThan('lg');
// These keys belong to this standalone app rather than Mado's preferences.
const COLLAPSED_STORAGE_KEY = 'mmt.navigation.collapsed';
const WIDTH_STORAGE_KEY = 'mmt.navigation.width';

/** sidebar: names and icons; rail: icons only; drawer: behind the menu button in the header. */
export type NavigationMode = 'sidebar' | 'rail' | 'drawer';

export interface Navigation {
  groups: NavigationGroup[];
  mode: NavigationMode;
  /** Wide screens let the user switch between the full sidebar and the rail. */
  canCollapse: boolean;
  toggleCollapsed: () => void;
  width: number;
  setWidth: (width: number) => void;
  resetWidth: () => void;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The navigation still works if storage is unavailable. */
  }
}

/**
 * The grouped screens the signed-in user may open, how the navigation shows them at the current
 * width, and the width and collapsed state the user chose for the full sidebar.
 */
export function useNavigation(projectId?: string, projectRole?: ProjectRole): Navigation {
  const auth = useAuth();
  const usesDrawer = useMediaQuery(DRAWER_QUERY);
  const fitsOnlyRail = useMediaQuery(RAIL_QUERY);
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSED_STORAGE_KEY) === 'true');
  const [width, setStoredWidth] = useState(() => storedNavigationWidth(readStorage(WIDTH_STORAGE_KEY)));
  useEffect(() => writeStorage(COLLAPSED_STORAGE_KEY, String(collapsed)), [collapsed]);
  useEffect(() => writeStorage(WIDTH_STORAGE_KEY, String(width)), [width]);
  const groups = navigationGroups({ projectId, projectRole, isGlobalAdmin: isGlobalAdmin(auth.user) });
  const mode: NavigationMode = usesDrawer ? 'drawer' : fitsOnlyRail || collapsed ? 'rail' : 'sidebar';
  return {
    groups,
    mode,
    canCollapse: !usesDrawer && !fitsOnlyRail,
    toggleCollapsed: () => setCollapsed((current) => !current),
    width,
    setWidth: (next) => setStoredWidth(clampNavigationWidth(next)),
    resetWidth: () => setStoredWidth(NAVIGATION_WIDTH.default),
  };
}

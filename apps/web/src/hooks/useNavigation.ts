import type { ProjectRole } from '@mmt/contracts';
import { navigationGroups, type NavigationGroup } from '../layout/navigationLinks';
import { isGlobalAdmin } from '../lib/permissions';
import { narrowerThan } from '../lib/breakpoints';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useAuth } from './useAuth';

// Below --bp-lg the sidebar and the Experiments list would leave too little width for the runs
// table, so the navigation moves into the drawer.
const DRAWER_NAVIGATION_QUERY = narrowerThan('lg');

export interface Navigation {
  groups: NavigationGroup[];
  usesDrawer: boolean;
}

/** The grouped screens the signed-in user may open, and whether the drawer or the sidebar holds them. */
export function useNavigation(projectId?: string, projectRole?: ProjectRole): Navigation {
  const auth = useAuth();
  const usesDrawer = useMediaQuery(DRAWER_NAVIGATION_QUERY);
  const groups = navigationGroups({ projectId, projectRole, isGlobalAdmin: isGlobalAdmin(auth.user) });
  return { groups, usesDrawer };
}

import type { ProjectRole } from '@mmt/contracts';
import { canManagePlugins } from '../lib/permissions';
import { text } from '../i18n/catalog';

export const ADMIN_PATH = '/admin';

type ProjectScreen =
  | 'experiments'
  | 'sweeps'
  | 'reports'
  | 'models'
  | 'tasks'
  | 'codes'
  | 'datasets'
  | 'artifacts'
  | 'lineage'
  | 'jobs'
  | 'hooks'
  | 'compute'
  | 'plugins'
  | 'settings';

// The fourteen Project screens in the groups the sidebar and the drawer show, in display order.
// The global administration page joins the last group.
const SCREEN_GROUPS: { label: string; screens: ProjectScreen[] }[] = [
  { label: text.navigationGroupTracking, screens: ['experiments', 'sweeps', 'reports'] },
  { label: text.navigationGroupModels, screens: ['models', 'tasks', 'codes'] },
  { label: text.navigationGroupData, screens: ['datasets', 'artifacts', 'lineage'] },
  { label: text.navigationGroupExecution, screens: ['jobs', 'hooks', 'compute'] },
  { label: text.navigationGroupManagement, screens: ['plugins', 'settings'] },
];

/** A Project screen, or the global administration page. */
export type NavigationScreen = ProjectScreen | 'administration';

export interface NavigationLink {
  screen: NavigationScreen;
  to: string;
  label: string;
}

export interface NavigationGroup {
  label: string;
  links: NavigationLink[];
}

interface NavigationAccess {
  projectId?: string;
  projectRole?: ProjectRole;
  isGlobalAdmin: boolean;
}

/**
 * The screens the main navigation offers, grouped: the open Project's screens (Plugins only for
 * those who may manage them) and, for global admins, the administration page. Groups without a
 * link are left out.
 */
export function navigationGroups({
  projectId,
  projectRole,
  isGlobalAdmin,
}: NavigationAccess): NavigationGroup[] {
  const groups: NavigationGroup[] = SCREEN_GROUPS.map(({ label, screens }) => ({
    label,
    links: projectId
      ? screens
          .filter((screen) => screen !== 'plugins' || canManagePlugins(projectRole, isGlobalAdmin))
          .map((screen) => ({ screen, to: `/projects/${projectId}/${screen}`, label: text[screen] }))
      : [],
  }));
  if (isGlobalAdmin)
    groups[groups.length - 1]!.links.push({
      screen: 'administration',
      to: ADMIN_PATH,
      label: text.administration,
    });
  return groups.filter((group) => group.links.length > 0);
}

/** The same screens as navigationGroups, in one list. */
export function navigationLinks(access: NavigationAccess): NavigationLink[] {
  return navigationGroups(access).flatMap((group) => group.links);
}

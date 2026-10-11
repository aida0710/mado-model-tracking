import type { ProjectRole } from '@mmt/contracts';
import { canManagePlugins } from '../lib/permissions';
import { text } from '../i18n/catalog';
import {
  ADMIN_SECTION_LABELS,
  ADMIN_SECTIONS,
  adminSectionPath,
  type AdminSection,
} from './adminSections';

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
// The global administration screens follow in a group of their own.
const SCREEN_GROUPS: { label: string; screens: ProjectScreen[] }[] = [
  { label: text.navigationGroupTracking, screens: ['experiments', 'sweeps', 'reports'] },
  { label: text.navigationGroupModels, screens: ['models', 'tasks', 'codes'] },
  { label: text.navigationGroupData, screens: ['datasets', 'artifacts', 'lineage'] },
  { label: text.navigationGroupExecution, screens: ['jobs', 'hooks', 'compute'] },
  { label: text.navigationGroupProjectManagement, screens: ['plugins', 'settings'] },
];

/** A Project screen, or a global administration screen. */
export type NavigationScreen = ProjectScreen | AdminSection;

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

/** Where a Project opens: its experiments. */
export function projectHomePath(projectId: string): string {
  return `/projects/${projectId}/experiments`;
}

/**
 * The screens the main navigation offers, grouped: the open Project's screens (Plugins only for
 * those who may manage them) and, for global admins, the global administration screens. Groups
 * without a link are left out.
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
    groups.push({
      label: text.administration,
      links: ADMIN_SECTIONS.map((section) => ({
        screen: section,
        to: adminSectionPath(section),
        label: ADMIN_SECTION_LABELS[section],
      })),
    });
  return groups.filter((group) => group.links.length > 0);
}

/** The same screens as navigationGroups, in one list. */
export function navigationLinks(access: NavigationAccess): NavigationLink[] {
  return navigationGroups(access).flatMap((group) => group.links);
}

import type { ProjectRole } from '@mmt/contracts';
import { canManagePlugins } from '../lib/permissions';
import { text } from '../i18n/catalog';
import {
  ADMIN_SECTIONS,
  GENERAL_SETTINGS_SECTIONS,
  SETTINGS_SECTION_LABELS,
  settingsSectionPath,
  type SettingsSection,
} from './settingsSections';

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
// The 全体設定 screens have groups of their own, shown only away from a Project.
const SCREEN_GROUPS: { label: string; screens: ProjectScreen[] }[] = [
  { label: text.navigationGroupTracking, screens: ['experiments', 'sweeps', 'reports'] },
  { label: text.navigationGroupModels, screens: ['models', 'tasks', 'codes'] },
  { label: text.navigationGroupData, screens: ['datasets', 'artifacts', 'lineage'] },
  { label: text.navigationGroupExecution, screens: ['jobs', 'hooks', 'compute'] },
  { label: text.navigationGroupProjectManagement, screens: ['plugins', 'settings'] },
];

/** A Project screen, or a 全体設定 screen (including the 全体管理 ones). */
export type NavigationScreen = ProjectScreen | SettingsSection;

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

function settingsLinks(sections: readonly SettingsSection[]): NavigationLink[] {
  return sections.map((section) => ({
    screen: section,
    to: settingsSectionPath(section),
    label: SETTINGS_SECTION_LABELS[section],
  }));
}

/**
 * The screens the main navigation offers, grouped. With a Project open: its screens (Plugins only
 * for those who may manage them); 全体設定 is reached from the user menu instead. Without one (the
 * 全体設定 screens, or no Project to open): 全体設定 for everyone and, for global admins, 全体管理.
 * Groups without a link are left out.
 */
export function navigationGroups({
  projectId,
  projectRole,
  isGlobalAdmin,
}: NavigationAccess): NavigationGroup[] {
  if (!projectId) return settingsGroups(isGlobalAdmin);
  return SCREEN_GROUPS.map(({ label, screens }) => ({
    label,
    links: screens
      .filter((screen) => screen !== 'plugins' || canManagePlugins(projectRole, isGlobalAdmin))
      .map((screen) => ({ screen, to: `/projects/${projectId}/${screen}`, label: text[screen] })),
  })).filter((group) => group.links.length > 0);
}

function settingsGroups(isGlobalAdmin: boolean): NavigationGroup[] {
  const groups: NavigationGroup[] = [
    { label: text.globalSettings, links: settingsLinks(GENERAL_SETTINGS_SECTIONS) },
  ];
  if (isGlobalAdmin)
    groups.push({ label: text.administration, links: settingsLinks(ADMIN_SECTIONS) });
  return groups;
}

/** The same screens as navigationGroups, in one list. */
export function navigationLinks(access: NavigationAccess): NavigationLink[] {
  return navigationGroups(access).flatMap((group) => group.links);
}

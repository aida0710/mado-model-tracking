import type { ProjectRole } from '@mmt/contracts';
import { canManagePlugins } from '../lib/permissions';
import { text } from '../i18n/catalog';

export const ADMIN_PATH = '/admin';

const PROJECT_SCREENS = [
  'experiments',
  'sweeps',
  'reports',
  'tasks',
  'models',
  'codes',
  'datasets',
  'artifacts',
  'lineage',
  'jobs',
  'compute',
  'plugins',
  'settings',
] as const;

export interface NavigationLink {
  to: string;
  label: string;
}

/**
 * The screens the main navigation offers: the open Project's screens (Plugins only for those who
 * may manage them) and, for global admins, the administration page.
 */
export function navigationLinks({
  projectId,
  projectRole,
  isGlobalAdmin,
}: {
  projectId?: string;
  projectRole?: ProjectRole;
  isGlobalAdmin: boolean;
}): NavigationLink[] {
  const projectLinks = projectId
    ? PROJECT_SCREENS.filter(
        (screen) => screen !== 'plugins' || canManagePlugins(projectRole, isGlobalAdmin),
      ).map((screen) => ({ to: `/projects/${projectId}/${screen}`, label: text[screen] }))
    : [];
  return isGlobalAdmin
    ? [...projectLinks, { to: ADMIN_PATH, label: text.administration }]
    : projectLinks;
}

import { text } from '../i18n/catalog';

export const ADMIN_PATH = '/admin';

/** The global administration screens, each at /admin/<section>, in the sidebar's order. */
export const ADMIN_SECTIONS = ['projects', 'users', 'storage', 'launchers', 'audit'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

// /admin opens the Project list, where Projects are created, archived and restored.
export const DEFAULT_ADMIN_SECTION: AdminSection = 'projects';

export const ADMIN_SECTION_LABELS: Record<AdminSection, string> = {
  projects: text.adminSectionProjects,
  users: text.adminSectionUsers,
  storage: text.adminSectionStorage,
  launchers: text.adminSectionLaunchers,
  audit: text.adminSectionAudit,
};

export function adminSectionPath(section: AdminSection): string {
  return `${ADMIN_PATH}/${section}`;
}

export function isAdminSection(value: string | undefined): value is AdminSection {
  return (ADMIN_SECTIONS as readonly string[]).includes(value ?? '');
}

import {
  isAdminSection,
  PASSWORD_CHANGE_PATH,
  settingsSectionPath,
  type AdminSection,
} from './settingsSections';

// /admin used to open the Project list, so a bookmark of it keeps landing there.
const LEGACY_ADMIN_HOME: AdminSection = 'projects';

/** The route patterns of the URLs from before 全体設定, each sent on by settingsPathForLegacyPath. */
export const LEGACY_SETTINGS_ROUTES = [
  '/account',
  '/account/password',
  '/admin',
  '/admin/:section',
];

/**
 * Where a URL from before 全体設定 now lives: /account and /account/password moved under
 * /settings/account, and /admin/<section> to /settings/<section>. Unknown /admin sections land on
 * the Project list as they used to. Anything else is not a legacy URL and gives undefined.
 */
export function settingsPathForLegacyPath(pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/account') return settingsSectionPath('account');
  if (path === '/account/password') return PASSWORD_CHANGE_PATH;
  if (path === '/admin') return settingsSectionPath(LEGACY_ADMIN_HOME);
  const adminSection = path.match(/^\/admin\/([^/]+)$/)?.[1];
  if (adminSection === undefined) return undefined;
  return settingsSectionPath(isAdminSection(adminSection) ? adminSection : LEGACY_ADMIN_HOME);
}

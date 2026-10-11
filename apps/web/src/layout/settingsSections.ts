import { text } from '../i18n/catalog';

/** 全体設定: the screens that belong to no Project, each at /settings/<section>. */
export const SETTINGS_PATH = '/settings';

/** The 全体設定 group, open to every signed-in user, in the sidebar's order. */
export const GENERAL_SETTINGS_SECTIONS = ['account', 'computers'] as const;
export type GeneralSettingsSection = (typeof GENERAL_SETTINGS_SECTIONS)[number];

/** The 全体管理 group, for global administrators only, in the sidebar's order. */
export const ADMIN_SECTIONS = ['projects', 'users', 'storage', 'launchers', 'audit'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export type SettingsSection = GeneralSettingsSection | AdminSection;

// /settings opens the user's own account, the one section everyone has.
export const DEFAULT_SETTINGS_SECTION: GeneralSettingsSection = 'account';

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  account: text.account,
  computers: text.settingsSectionComputers,
  projects: text.adminSectionProjects,
  users: text.adminSectionUsers,
  storage: text.adminSectionStorage,
  launchers: text.adminSectionLaunchers,
  audit: text.adminSectionAudit,
};

export function settingsSectionPath(section: SettingsSection): string {
  return `${SETTINGS_PATH}/${section}`;
}

/** Local accounts change their password here; it belongs to the account section. */
export const PASSWORD_CHANGE_PATH = `${settingsSectionPath('account')}/password`;

export function isAdminSection(value: string | undefined): value is AdminSection {
  return (ADMIN_SECTIONS as readonly string[]).includes(value ?? '');
}

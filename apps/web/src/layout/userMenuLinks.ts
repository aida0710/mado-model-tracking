import type { User } from '@mmt/contracts';
import { canChangeOwnPassword } from '../lib/permissions';
import { text } from '../i18n/catalog';
import { PASSWORD_CHANGE_PATH, settingsSectionPath } from './settingsSections';

export interface UserMenuLink {
  to: string;
  label: string;
  /** Opens 全体設定 as a whole rather than one of the user's own pages; set apart by a rule. */
  isSettingsEntry?: boolean;
}

/**
 * The user menu's links: the account, the password change for local accounts, and 全体設定 for
 * everyone. 全体設定 opens on the account; its sidebar leads on to コンピュータ and 全体管理.
 */
export function userMenuLinks(user: Pick<User, 'authSources'>): UserMenuLink[] {
  const accountPath = settingsSectionPath('account');
  const passwordChange = { to: PASSWORD_CHANGE_PATH, label: text.passwordChange };
  return [
    { to: accountPath, label: text.account },
    ...(canChangeOwnPassword(user) ? [passwordChange] : []),
    { to: accountPath, label: text.globalSettings, isSettingsEntry: true },
  ];
}

import type { ReactNode } from 'react';
import { PageHeader } from './PageHeader';
import {
  isAdminSection,
  SETTINGS_SECTION_LABELS,
  type SettingsSection,
} from '../layout/settingsSections';
import { text } from '../i18n/catalog';

/**
 * The heading of a 全体設定 screen: its name, with the sidebar group it belongs to (「全体設定」 or
 * 「全体管理」) above it, and its actions. A page inside a section, such as the password change in
 * the account section, passes its own title.
 */
export function SettingsPageHeader({
  section,
  title = SETTINGS_SECTION_LABELS[section],
  actions,
}: {
  section: SettingsSection;
  title?: string;
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      eyebrow={isAdminSection(section) ? text.administration : text.globalSettings}
      title={title}
      actions={actions}
    />
  );
}

import type { ReactNode } from 'react';
import { PageHeader } from '../PageHeader';
import { ADMIN_SECTION_LABELS, type AdminSection } from '../../layout/adminSections';
import { text } from '../../i18n/catalog';

/**
 * The heading of a global administration screen: its sidebar name under 「全体管理」, and its
 * actions.
 */
export function AdminSectionHeader({
  section,
  actions,
}: {
  section: AdminSection;
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      eyebrow={text.administration}
      title={ADMIN_SECTION_LABELS[section]}
      actions={actions}
    />
  );
}

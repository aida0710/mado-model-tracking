import type { ComponentType } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { AuditEventsPanel } from '../components/admin/AuditEventsPanel';
import { LaunchersPanel } from '../components/admin/LaunchersPanel';
import { ProjectsPanel } from '../components/admin/ProjectsPanel';
import { StorageBackendsPanel } from '../components/admin/StorageBackendsPanel';
import { UsersPanel } from '../components/admin/UsersPanel';
import { useAuth } from '../hooks/useAuth';
import { isGlobalAdmin } from '../lib/permissions';
import {
  DEFAULT_SETTINGS_SECTION,
  isAdminSection,
  settingsSectionPath,
  type AdminSection,
} from '../layout/settingsSections';

// Each section heads itself (SettingsPageHeader) with its own actions; the sidebar switches them.
const ADMIN_SECTION_PANELS: Record<AdminSection, ComponentType> = {
  projects: ProjectsPanel,
  users: UsersPanel,
  storage: StorageBackendsPanel,
  launchers: LaunchersPanel,
  audit: AuditEventsPanel,
};

/**
 * 全体設定 → 全体管理 (/settings/<section>), for global administrators. Anyone else, whom the API
 * would refuse, and an unknown section land on the user's own account in 全体設定.
 */
export function AdminPage() {
  const auth = useAuth();
  const { section } = useParams();
  if (!isGlobalAdmin(auth.user) || !isAdminSection(section))
    return <Navigate replace to={settingsSectionPath(DEFAULT_SETTINGS_SECTION)} />;
  const Panel = ADMIN_SECTION_PANELS[section];
  return <Panel />;
}

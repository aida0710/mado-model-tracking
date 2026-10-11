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
  adminSectionPath,
  DEFAULT_ADMIN_SECTION,
  isAdminSection,
  type AdminSection,
} from '../layout/adminSections';

// Each section heads itself (AdminSectionHeader) with its own actions; the sidebar switches them.
const ADMIN_SECTION_PANELS: Record<AdminSection, ComponentType> = {
  projects: ProjectsPanel,
  users: UsersPanel,
  storage: StorageBackendsPanel,
  launchers: LaunchersPanel,
  audit: AuditEventsPanel,
};

/**
 * Global administration (/admin/<section>). The API refuses everyone else, so they are sent home.
 */
export function AdminPage() {
  const auth = useAuth();
  const { section } = useParams();
  if (!isGlobalAdmin(auth.user)) return <Navigate replace to="/" />;
  if (!isAdminSection(section))
    return <Navigate replace to={adminSectionPath(DEFAULT_ADMIN_SECTION)} />;
  const Panel = ADMIN_SECTION_PANELS[section];
  return <Panel />;
}

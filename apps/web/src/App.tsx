import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './hooks/useAuth';
import { AppShell } from './layout/AppShell';
import { AccountShell } from './layout/AccountShell';
import { ACCOUNT_PASSWORD_PATH, ADMIN_PATH } from './layout/TopBar';
import { Loading } from './components/Feedback';
// Already in the main bundle because AuthGate shows it for a required change.
import { ChangePasswordPage } from './pages/ChangePasswordPage';
const ExperimentsPage = lazy(() =>
  import('./pages/ExperimentsPage').then((module) => ({ default: module.ExperimentsPage })),
);
const RunDetailPage = lazy(() =>
  import('./pages/RunDetailPage').then((module) => ({ default: module.RunDetailPage })),
);
const ComparePage = lazy(() =>
  import('./pages/ComparePage').then((module) => ({ default: module.ComparePage })),
);
const ModelsPage = lazy(() =>
  import('./pages/ModelsPage').then((module) => ({ default: module.ModelsPage })),
);
const CodesPage = lazy(() =>
  import('./pages/CodesPage').then((module) => ({ default: module.CodesPage })),
);
const DatasetsPage = lazy(() =>
  import('./pages/DatasetsPage').then((module) => ({ default: module.DatasetsPage })),
);
const ArtifactsPage = lazy(() =>
  import('./pages/ArtifactsPage').then((module) => ({ default: module.ArtifactsPage })),
);
const LineagePage = lazy(() =>
  import('./pages/LineagePage').then((module) => ({ default: module.LineagePage })),
);
const JobsPage = lazy(() =>
  import('./pages/JobsPage').then((module) => ({ default: module.JobsPage })),
);
const TasksPage = lazy(() =>
  import('./pages/TasksPage').then((module) => ({ default: module.TasksPage })),
);
const ComputePage = lazy(() =>
  import('./pages/ComputePage').then((module) => ({ default: module.ComputePage })),
);
const PluginsPage = lazy(() =>
  import('./pages/PluginsPage').then((module) => ({ default: module.PluginsPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const AdminPage = lazy(() =>
  import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })),
);

export function App() {
  return (
    <AuthGate>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<AppShell />} />
          <Route element={<AccountShell />}>
            <Route
              path={ACCOUNT_PASSWORD_PATH}
              element={<ChangePasswordPage isRequired={false} />}
            />
            <Route path={ADMIN_PATH} element={<AdminPage />} />
          </Route>
          <Route path="/projects/:projectId" element={<AppShell />}>
            <Route index element={<Navigate replace to="experiments" />} />
            <Route path="experiments" element={<ExperimentsPage />} />
            <Route path="runs/:runId" element={<RunDetailPage />} />
            <Route path="compare" element={<ComparePage />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="codes" element={<CodesPage />} />
            <Route path="datasets" element={<DatasetsPage />} />
            <Route path="artifacts" element={<ArtifactsPage />} />
            <Route path="lineage" element={<LineagePage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="compute" element={<ComputePage />} />
            <Route path="plugins" element={<PluginsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate replace to="experiments" />} />
          </Route>
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </Suspense>
    </AuthGate>
  );
}

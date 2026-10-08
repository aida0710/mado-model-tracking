import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NavigationGuardProvider } from './components/NavigationGuardProvider';
// Area stylesheets. Order matters for equal-specificity rules: keep base first and add new rules
// to the file of the area they style instead of creating a catch-all stylesheet.
import './styles/base.css';
import './styles/layout.css';
import './styles/tables.css';
import './styles/registry.css';
import './styles/artifacts.css';
import './styles/audio.css';
import './styles/forms.css';
import './styles/workbench.css';
import './styles/admin.css';
import './styles/promotion.css';

// Keep the existing route tree while enabling blocked SPA navigation.
const router = createBrowserRouter([{
  path: '*',
  element: <ErrorBoundary><NavigationGuardProvider><App /></NavigationGuardProvider></ErrorBoundary>,
}]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);

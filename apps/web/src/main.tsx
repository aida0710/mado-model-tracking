import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NavigationGuardProvider } from './components/NavigationGuardProvider';
import './styles.css';

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

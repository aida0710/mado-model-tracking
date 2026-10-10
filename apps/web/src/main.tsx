import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NavigationGuardProvider } from './components/NavigationGuardProvider';
import { initialTheme } from './hooks/useTheme';
// Fonts and theme tokens shared with Mado. Noto Sans JP covers the Japanese text IBM Plex lacks.
import '@fontsource/noto-sans-jp/japanese-400.css';
import '@fontsource/noto-sans-jp/japanese-500.css';
import '@fontsource/noto-sans-jp/japanese-700.css';
import '@mado/design-tokens/fonts.css';
import '@mado/design-tokens/tokens.css';
// Element defaults, components and the app frame shared with Mado, before this app's area files.
import '@mado/design-tokens/base.css';
import '@mado/design-tokens/components.css';
import '@mado/design-tokens/shell.css';
// Area stylesheets. Order matters for equal-specificity rules: keep breakpoints (the width
// breakpoints every other stylesheet uses) and base first, and add new rules to the file of the
// area they style instead of creating a catch-all stylesheet.
import './styles/breakpoints.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/tables.css';
import './styles/registry.css';
import './styles/artifacts.css';
import './styles/artifactBrowser.css';
import './styles/audio.css';
import './styles/forms.css';
import './styles/workbench.css';
import './styles/narrowModelScreens.css';
import './styles/admin.css';
import './styles/projectAccess.css';
import './styles/promotion.css';
import './styles/uploads.css';
import './styles/modelVersion.css';
import './styles/checkpoints.css';
import './styles/connection.css';
import './styles/operations.css';
import './styles/charts.css';
import './styles/chartPanels.css';
import './styles/analysis.css';
import './styles/sweeps.css';
import './styles/media.css';
import './styles/comments.css';
import './styles/reports.css';
import './styles/savedViews.css';
import './styles/comparison.css';
import './styles/runList.css';
import './styles/datasets.css';
import './styles/responsiveManagement.css';

// The login screen and everything else start in the stored theme, or the operating system's.
document.documentElement.dataset.theme = initialTheme();

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

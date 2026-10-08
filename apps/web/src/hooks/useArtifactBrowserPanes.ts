import { useRef } from 'react';
import { artifactBrowserPanes } from '../lib/artifactBrowserPanes';
import { useIsNarrow } from '../lib/useMediaQuery';

/**
 * The panes an Artifact browser shows at the current width, and a ref for its outer element. On
 * a narrow screen switching between the list and the preview replaces one with the other, so
 * `scrollBrowserIntoView` brings the top of the browser back after the switch.
 */
export function useArtifactBrowserPanes(hasChosenFile: boolean) {
  const isNarrow = useIsNarrow();
  const containerRef = useRef<HTMLDivElement>(null);
  const panes = artifactBrowserPanes({ isNarrow, hasChosenFile });
  const scrollBrowserIntoView = () => {
    if (isNarrow) containerRef.current?.scrollIntoView({ block: 'nearest' });
  };
  return { isNarrow, panes, containerRef, scrollBrowserIntoView };
}

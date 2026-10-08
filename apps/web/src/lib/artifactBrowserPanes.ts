/** Which halves of an Artifact browser (the file list and the preview) are on screen. */
export interface ArtifactBrowserPanes {
  showList: boolean;
  showPreview: boolean;
  /** The preview offers a way back to the list, because the list is hidden behind it. */
  showBackToList: boolean;
}

/**
 * A wide screen shows the list and the preview side by side. A narrow one shows one at a time:
 * the list (breadcrumbs and the folder's entries) until a file is chosen, then that file's
 * preview with a way back. Nothing previews on its own there, so opening a folder does not fetch
 * a large file nobody asked to see.
 */
export function artifactBrowserPanes({
  isNarrow,
  hasChosenFile,
}: {
  isNarrow: boolean;
  hasChosenFile: boolean;
}): ArtifactBrowserPanes {
  if (!isNarrow) return { showList: true, showPreview: true, showBackToList: false };
  return { showList: !hasChosenFile, showPreview: hasChosenFile, showBackToList: hasChosenFile };
}

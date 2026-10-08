import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Artifact } from '@mmt/contracts';
import { ArtifactActionsMenu } from './ArtifactActionsMenu';
import { ArtifactBackToListButton } from './ArtifactBackToListButton';
import { ArtifactPreview } from './ArtifactPreview';
import { ArtifactTree } from './ArtifactTree';
import { ErrorNotice, Resource } from './Feedback';
import { useArtifactBrowserPanes } from '../hooks/useArtifactBrowserPanes';
import { useProject } from '../hooks/useProject';
import { useArtifactVersions, useRunArtifacts } from '../hooks/useRunArtifacts';
import { formatBytes, formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

// Kept in the URL so reloading or going back returns to the same folder.
const PREFIX_PARAMETER = 'artifactPrefix';

/**
 * A Run's Artifacts as a folder tree on the left and the chosen file's preview on the right; on a
 * narrow screen, the tree until a file is chosen and then that file's preview.
 */
export function RunArtifacts({
  projectId,
  runId,
  revision,
}: {
  projectId: string;
  runId: string;
  /** Increment to reload after an upload. */
  revision: number;
}) {
  const [params, setParams] = useSearchParams();
  const prefix = params.get(PREFIX_PARAMETER) ?? '';
  // Counts deletions made here, so the folder and the open file reload after each one.
  const [deletions, setDeletions] = useState(0);
  const { tree, files } = useRunArtifacts({ projectId, runId, prefix }, revision + deletions);
  const [chosen, setChosen] = useState<Artifact>();
  const { isNarrow, panes, containerRef, scrollBrowserIntoView } = useArtifactBrowserPanes(chosen !== undefined);
  // Like the earlier flat list, the first file of the open folder previews until one is chosen.
  const selected = chosen ?? (isNarrow ? undefined : files.items[0]);
  function showFile(artifact: Artifact | undefined) {
    setChosen(artifact);
    scrollBrowserIntoView();
  }
  function openDirectory(next: string) {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      if (next) updated.set(PREFIX_PARAMETER, next);
      else updated.delete(PREFIX_PARAMETER);
      return updated;
    });
  }
  return (
    <div ref={containerRef} className="artifact-layout artifact-browser touch-targets">
      {panes.showList && (
        <div>
          <Resource query={tree}>
            {(level) => (
              <ArtifactTree
                tree={level}
                files={files.items}
                selectedArtifactId={selected?.id}
                onOpenDirectory={openDirectory}
                onSelectFile={showFile}
                hasMoreFiles={files.hasMore}
                loadingFiles={files.loading}
                onLoadMoreFiles={files.loadMore}
              />
            )}
          </Resource>
          <ErrorNotice message={files.error} retry={files.reload} />
        </div>
      )}
      {panes.showBackToList && <ArtifactBackToListButton onClick={() => showFile(undefined)} />}
      {panes.showPreview &&
        (selected ? (
          <ArtifactDetails
            key={`${selected.id}:${deletions}`}
            latest={selected}
            onDeleted={() => {
              setChosen(undefined);
              setDeletions((count) => count + 1);
            }}
          />
        ) : (
          <section className="artifact-preview">
            <p className="muted">{text.artifactSelectFile}</p>
          </section>
        ))}
    </div>
  );
}

/** Preview of the latest upload, with earlier uploads to the same path under the details. */
function ArtifactDetails({ latest, onDeleted }: { latest: Artifact; onDeleted: () => void }) {
  const { isProjectAdmin } = useProject();
  const [shown, setShown] = useState(latest);
  const versions = useArtifactVersions(latest);
  const isPrevious = shown.id !== latest.id;
  return (
    <section className="artifact-preview">
      <div className="artifact-preview-heading">
        <h3>{shown.path}</h3>
        {isProjectAdmin && <ArtifactActionsMenu artifact={shown} onDeleted={onDeleted} />}
      </div>
      <p className="mono muted">
        {shown.mimeType} · {formatBytes(shown.size)} · {formatDate(shown.createdAt)}
      </p>
      {isPrevious && (
        <p className="artifact-version-notice">
          {text.artifactShowingPreviousVersion}{' '}
          <button className="link-button" onClick={() => setShown(latest)}>
            {text.artifactShowLatest}
          </button>
        </p>
      )}
      <ArtifactPreview key={shown.id} artifact={shown} />
      <details>
        <summary>{text.details}</summary>
        <p className="mono break-word">
          {text.artifactId}: {shown.id}
        </p>
        <p className="mono break-word">SHA-256 {shown.sha256}</p>
        <p className="mono">{shown.backend}</p>
        <h4>{text.artifactPreviousVersions}</h4>
        <Resource query={versions}>
          {(previous) =>
            previous.length ? (
              <ul className="artifact-version-list">
                {previous.map((version) => (
                  <li key={version.id} className={version.id === shown.id ? 'selected' : ''}>
                    <button className="link-button mono" onClick={() => setShown(version)}>
                      {formatDate(version.createdAt)}
                    </button>
                    <span className="mono muted">
                      {formatBytes(version.size)} · {version.sha256.slice(0, 12)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{text.artifactNoPreviousVersions}</p>
            )
          }
        </Resource>
      </details>
    </section>
  );
}

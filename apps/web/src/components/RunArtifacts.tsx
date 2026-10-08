import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Artifact } from '@mmt/contracts';
import { ArtifactPreview } from './ArtifactPreview';
import { ArtifactTree } from './ArtifactTree';
import { ErrorNotice, Resource } from './Feedback';
import { useArtifactVersions, useRunArtifacts } from '../hooks/useRunArtifacts';
import { formatBytes, formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

// Kept in the URL so reloading or going back returns to the same folder.
const PREFIX_PARAMETER = 'artifactPrefix';

/** A Run's Artifacts as a folder tree on the left and the chosen file's preview on the right. */
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
  const { tree, files } = useRunArtifacts({ projectId, runId, prefix }, revision);
  const [chosen, setChosen] = useState<Artifact>();
  // Like the earlier flat list, the first file of the open folder previews until one is chosen.
  const selected = chosen ?? files.items[0];
  function openDirectory(next: string) {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      if (next) updated.set(PREFIX_PARAMETER, next);
      else updated.delete(PREFIX_PARAMETER);
      return updated;
    });
  }
  return (
    <div className="artifact-layout artifact-browser">
      <div>
        <Resource query={tree}>
          {(level) => (
            <ArtifactTree
              tree={level}
              files={files.items}
              selectedArtifactId={selected?.id}
              onOpenDirectory={openDirectory}
              onSelectFile={setChosen}
              hasMoreFiles={files.hasMore}
              loadingFiles={files.loading}
              onLoadMoreFiles={files.loadMore}
            />
          )}
        </Resource>
        <ErrorNotice message={files.error} retry={files.reload} />
      </div>
      {selected ? (
        <ArtifactDetails key={selected.id} latest={selected} />
      ) : (
        <section className="artifact-preview">
          <p className="muted">{text.artifactSelectFile}</p>
        </section>
      )}
    </div>
  );
}

/** Preview of the latest upload, with earlier uploads to the same path under the details. */
function ArtifactDetails({ latest }: { latest: Artifact }) {
  const [shown, setShown] = useState(latest);
  const versions = useArtifactVersions(latest);
  const isPrevious = shown.id !== latest.id;
  return (
    <section className="artifact-preview">
      <h3>{shown.path}</h3>
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

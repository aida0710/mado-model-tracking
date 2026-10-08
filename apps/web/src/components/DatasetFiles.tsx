import { useState } from 'react';
import type { Artifact, DatasetVersion } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { useDatasetFiles } from '../hooks/useDatasetFiles';
import { useQuery } from '../hooks/useQuery';
import { datasetFileTreeEntry } from '../lib/datasetFolder';
import { formatBytes } from '../lib/format';
import { ArtifactPreview } from './ArtifactPreview';
import { ArtifactTree } from './ArtifactTree';
import { ErrorNotice, Resource } from './Feedback';
import { text } from '../i18n/catalog';

/** The files of an 'artifacts' DatasetVersion as a folder tree, with the chosen file's preview. */
export function DatasetFiles({ version }: { version: DatasetVersion }) {
  const [prefix, setPrefix] = useState('');
  const [chosen, setChosen] = useState<Artifact>();
  const { tree, files } = useDatasetFiles(
    { projectId: version.projectId, datasetId: version.datasetId, versionId: version.id },
    prefix,
  );
  const entries = files.items.map((file) => datasetFileTreeEntry(file, version.projectId));
  return (
    <div className="artifact-layout artifact-browser">
      <div>
        <Resource query={tree}>
          {(level) => (
            <ArtifactTree
              tree={level}
              files={entries}
              selectedArtifactId={chosen?.id}
              onOpenDirectory={(next) => {
                setPrefix(next);
                setChosen(undefined);
              }}
              onSelectFile={setChosen}
              hasMoreFiles={files.hasMore}
              loadingFiles={files.loading}
              onLoadMoreFiles={files.loadMore}
            />
          )}
        </Resource>
        <ErrorNotice message={files.error} retry={files.reload} />
      </div>
      {chosen ? (
        <DatasetFilePreview key={chosen.id} entry={chosen} />
      ) : (
        <section className="artifact-preview">
          <p className="muted">{text.datasetFileSelect}</p>
        </section>
      )}
    </div>
  );
}

/** The tree entry carries the dataset path; the preview needs the stored Artifact itself. */
function DatasetFilePreview({ entry }: { entry: Artifact }) {
  const artifact = useQuery(`${entry.projectId}:artifact:${entry.id}`, (signal) =>
    trackingApi.artifact(entry.projectId, entry.id, signal),
  );
  return (
    <section className="artifact-preview">
      <h3>{entry.path}</h3>
      <p className="mono muted">
        {entry.mimeType} · {formatBytes(entry.size)}
      </p>
      <Resource query={artifact}>{(stored) => <ArtifactPreview artifact={stored} />}</Resource>
    </section>
  );
}

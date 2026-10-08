// Paths for turning a chosen folder into an 'artifacts' DatasetVersion, and the tree rows of its files.
import type { Artifact, DatasetVersionFile } from '@mmt/contracts';
import type { UploadSource } from './droppedFiles';
import { joinArtifactPath } from './uploadPlan';

/** A chosen file, its path inside the dataset, and the Artifact path it is uploaded to. */
export interface DatasetFolderEntry {
  source: UploadSource;
  datasetPath: string;
  artifactPath: string;
}

/**
 * A folder picker names every file `<folder>/<path>`; the folder name is not part of the dataset,
 * so a first segment shared by every file is dropped. Loose files keep their names.
 */
export function datasetPathsOf(sources: UploadSource[]): string[] {
  const segments = sources.map((source) => joinArtifactPath('', source.relativePath).split('/'));
  const top = segments[0]?.[0];
  const sharesTopFolder =
    segments.length > 0 && segments.every((parts) => parts.length > 1 && parts[0] === top);
  return segments.map((parts) => (sharesTopFolder ? parts.slice(1) : parts).join('/'));
}

/**
 * Each folder upload goes to its own Artifact directory under the dataset, so uploads of the same
 * file names for different versions never replace one another in the Project catalog.
 */
export function planDatasetFolder(
  sources: UploadSource[],
  location: { datasetId: string; uploadId: string },
): DatasetFolderEntry[] {
  const datasetPaths = datasetPathsOf(sources);
  return sources.map((source, index) => {
    const datasetPath = datasetPaths[index]!;
    return {
      source,
      datasetPath,
      artifactPath: joinArtifactPath(`datasets/${location.datasetId}/${location.uploadId}`, datasetPath),
    };
  });
}

/**
 * ArtifactTree shows Artifacts; a dataset file is shown under its dataset path with the Artifact's
 * ID, size, and type. Fields the tree does not read are left empty.
 */
export function datasetFileTreeEntry(file: DatasetVersionFile, projectId: string): Artifact {
  return {
    id: file.artifactId,
    projectId,
    runId: null,
    path: file.path,
    backend: '',
    storageKey: '',
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    createdAt: '',
  };
}

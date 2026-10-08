import type { Artifact, RunMedia } from '@mmt/contracts';
import type { ResolvedMediaCell } from './mediaTableCells';

/**
 * The previews in components/preview/ take an Artifact but read only its id, projectId, runId,
 * path, mimeType and size. Run media and table cells carry exactly those, so the preview gets
 * them without one GET /artifacts/:id per cell; the storage fields are left blank because no
 * preview reads them.
 */
function previewArtifact(fields: Pick<Artifact, 'id' | 'projectId' | 'runId' | 'path' | 'mimeType' | 'size'>): Artifact {
  return { ...fields, backend: 'filesystem', storageKey: '', sha256: '', createdAt: '' };
}

export function runMediaArtifact(projectId: string, media: RunMedia): Artifact {
  return previewArtifact({
    id: media.artifactId,
    projectId,
    runId: media.runId,
    path: media.path,
    mimeType: media.mimeType,
    size: media.size,
  });
}

// Table cells name no MIME type, so the preview is chosen by the cell's kind.
const DEFAULT_MIME_TYPES: Record<ResolvedMediaCell['type'], string> = {
  audio: 'audio/wav',
  image: 'image/png',
  video: 'video/mp4',
};

export function tableCellArtifact(projectId: string, cell: ResolvedMediaCell): Artifact {
  return previewArtifact({
    id: cell.artifactId,
    projectId,
    runId: cell.runId,
    path: cell.path,
    // Table cells carry no MIME type or size; the previews decode from the content itself.
    mimeType: DEFAULT_MIME_TYPES[cell.type],
    // 0 keeps the browser analysis, so a cell over 64MiB is fetched whole until cells carry a size.
    size: 0,
  });
}

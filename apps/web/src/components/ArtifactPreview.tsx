import { useEffect, useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { artifactMediaKind } from '../lib/artifactMediaKind';
import { useQuery } from '../hooks/useQuery';
import { ErrorNotice, Resource } from './Feedback';
import { text } from '../i18n/catalog';

// Text previews stay bounded; large files use the streaming download link.
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
export function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const url = trackingApi.artifactUrl(artifact.projectId, artifact.id);
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => setMediaError(false), [artifact.id]);
  const mediaKind = artifactMediaKind(artifact.mimeType);
  const canPreviewText = mediaKind === 'text' && artifact.size <= TEXT_PREVIEW_MAX_BYTES;
  const content = useQuery(canPreviewText ? `${artifact.id}:text` : null, (signal) =>
    trackingApi.artifactText(artifact.projectId, artifact.id, signal),
  );
  if (canPreviewText)
    return (
      <Resource query={content}>{(value) => <pre className="artifact-text">{value}</pre>}</Resource>
    );
  if (mediaError)
    return <ErrorNotice message={text.contentError} retry={() => setMediaError(false)} />;
  if (mediaKind === 'image')
    return (
      <img
        className="artifact-image"
        src={url}
        alt={artifact.path}
        onError={() => setMediaError(true)}
      />
    );
  if (mediaKind === 'audio')
    return (
      <audio
        controls
        preload="metadata"
        src={url}
        onError={() => setMediaError(true)}
        aria-label={artifact.path}
      />
    );
  if (mediaKind === 'video')
    return (
      <video
        className="artifact-video"
        controls
        preload="metadata"
        src={url}
        onError={() => setMediaError(true)}
        aria-label={artifact.path}
      />
    );
  return <p className="muted">{text.previewUnsupported}</p>;
}

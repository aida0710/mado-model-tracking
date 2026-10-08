import { useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { trackingApi } from '../../api/tracking';
import { ErrorNotice } from '../Feedback';
import { text } from '../../i18n/catalog';

export function VideoPreview({ artifact }: { artifact: Artifact }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ErrorNotice message={text.contentError} retry={() => setFailed(false)} />;
  return (
    <video
      className="artifact-video"
      controls
      preload="metadata"
      src={trackingApi.artifactUrl(artifact.projectId, artifact.id)}
      onError={() => setFailed(true)}
      aria-label={artifact.path}
    />
  );
}

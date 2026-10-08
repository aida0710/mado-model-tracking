import { useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { trackingApi } from '../../api/tracking';
import { ErrorNotice } from '../Feedback';
import { text } from '../../i18n/catalog';

export function ImagePreview({ artifact }: { artifact: Artifact }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ErrorNotice message={text.contentError} retry={() => setFailed(false)} />;
  return (
    <img
      className="artifact-image"
      src={trackingApi.artifactUrl(artifact.projectId, artifact.id)}
      alt={artifact.path}
      onError={() => setFailed(true)}
    />
  );
}

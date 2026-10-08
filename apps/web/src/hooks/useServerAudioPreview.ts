import { useEffect, useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { artifactPreviewsApi } from '../api/artifactPreviews';
import { trackingApi } from '../api/tracking';
import { summarizeServerAudioPreviews, type ServerWaveform } from '../lib/serverAudioPreview';
import { EXECUTION_POLL_MS, useQuery } from './useQuery';

export type ServerAudioPreviewState =
  | { status: 'none' | 'pending' | 'failed' }
  | { status: 'ready'; waveform: ServerWaveform; spectrogramUrl: string | null };

/**
 * The server-generated waveform and spectrogram of an audio Artifact the browser does not analyze.
 * Polls while the preview worker is still generating them. A failed request reads as 'none':
 * playback works without a preview, so the error is not shown.
 */
export function useServerAudioPreview(
  artifact: Pick<Artifact, 'projectId' | 'id'>,
  enabled: boolean,
): ServerAudioPreviewState {
  const listKey = enabled ? `${artifact.projectId}/${artifact.id}` : null;
  // The key whose previews have settled; polling stops for it and restarts for another Artifact.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const previews = useQuery(
    listKey,
    (signal) => artifactPreviewsApi.list(artifact.projectId, artifact.id, signal),
    settledKey === listKey ? undefined : EXECUTION_POLL_MS,
  );
  const summary = previews.value ? summarizeServerAudioPreviews(previews.value) : null;
  // A failed request also stops polling: the viewer then plays the file without a preview.
  const isSettled = (summary !== null && summary.status !== 'pending') || previews.error !== null;
  useEffect(() => {
    if (isSettled) setSettledKey(listKey);
  }, [isSettled, listKey]);

  const peaksArtifactId = summary?.status === 'ready' ? summary.peaksArtifactId : null;
  const waveform = useQuery(peaksArtifactId, (signal) =>
    artifactPreviewsApi.waveform(artifact.projectId, peaksArtifactId!, signal),
  );
  if (!summary) return { status: previews.loading ? 'pending' : 'none' };
  if (summary.status !== 'ready') return { status: summary.status };
  if (!waveform.value) return { status: waveform.error ? 'none' : 'pending' };
  return {
    status: 'ready',
    waveform: waveform.value,
    spectrogramUrl: summary.spectrogramArtifactId
      ? trackingApi.artifactUrl(artifact.projectId, summary.spectrogramArtifactId)
      : null,
  };
}

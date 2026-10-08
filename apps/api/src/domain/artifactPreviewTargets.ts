import { BROWSER_AUDIO_ANALYSIS_MAX_BYTES, type ArtifactPreviewKind } from '@mmt/contracts';

const AUDIO_PREVIEW_KINDS: readonly ArtifactPreviewKind[] = ['waveform-peaks', 'spectrogram'];
const VIDEO_PREVIEW_KINDS: readonly ArtifactPreviewKind[] = ['video-poster'];

/**
 * The previews a newly registered Artifact needs. Audio gets them when the browser cannot analyze
 * it (over its size limit) or when only ffprobe can read its media info; small WAV/FLAC are
 * covered by the browser and the header probe. Video always gets a poster.
 */
export function previewKindsFor(artifact: {
  mimeType: string;
  size: number;
  /** Whether registration reads this type's media info from its header. */
  isHeaderProbed: boolean;
}): readonly ArtifactPreviewKind[] {
  if (artifact.size === 0) return [];
  const essence = artifact.mimeType.split(';')[0]!.trim().toLowerCase();
  if (essence.startsWith('video/')) return VIDEO_PREVIEW_KINDS;
  if (!essence.startsWith('audio/')) return [];
  if (artifact.isHeaderProbed && artifact.size <= BROWSER_AUDIO_ANALYSIS_MAX_BYTES) return [];
  return AUDIO_PREVIEW_KINDS;
}

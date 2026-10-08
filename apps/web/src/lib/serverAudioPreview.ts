import type { ArtifactPreview, WaveformPeaksPreview } from '@mmt/contracts';
import type { WaveformPeaks } from './audioAnalysis';

/** The server's whole-file waveform, decoded from a 'waveform-peaks' preview Artifact. */
export interface ServerWaveform {
  peaks: WaveformPeaks;
  sampleRate: number;
  durationSeconds: number;
}

/** What the viewer can show for a file too large to analyze in the browser. */
export type ServerAudioPreviewSummary =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'ready'; peaksArtifactId: string; spectrogramArtifactId: string | null };

// The worker writes at most 8192 peaks; anything far beyond is not a file it produced.
const MAX_PEAK_COUNT = 65536;

function isPeakArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PEAK_COUNT &&
    value.every((peak) => typeof peak === 'number' && peak >= -1 && peak <= 1)
  );
}

/** null for anything that is not a version-1 peaks document. */
export function parseWaveformPeaksPreview(text: string): ServerWaveform | null {
  let document: Partial<WaveformPeaksPreview>;
  try {
    document = JSON.parse(text) as Partial<WaveformPeaksPreview>;
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null || document.version !== 1) return null;
  const { sampleRate, durationSeconds, min, max } = document;
  if (!Number.isInteger(sampleRate) || sampleRate! <= 0) return null;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  if (!isPeakArray(min) || !isPeakArray(max) || min.length !== max.length || min.length === 0) return null;
  return {
    peaks: { min: Float32Array.from(min), max: Float32Array.from(max) },
    sampleRate: sampleRate!,
    durationSeconds,
  };
}

/**
 * The waveform decides the state: without it there is nothing to draw. A missing spectrogram only
 * leaves its row empty. 'skipped' (no ffmpeg on the server, no audio stream) reads as 'none',
 * because there is nothing the user can retry.
 */
export function summarizeServerAudioPreviews(previews: readonly ArtifactPreview[]): ServerAudioPreviewSummary {
  const peaks = previews.find((preview) => preview.kind === 'waveform-peaks');
  const spectrogram = previews.find((preview) => preview.kind === 'spectrogram');
  if (!peaks || peaks.status === 'skipped') return { status: 'none' };
  if (peaks.status === 'queued' || peaks.status === 'running') return { status: 'pending' };
  if (peaks.status === 'failed' || !peaks.previewArtifactId) return { status: 'failed' };
  return {
    status: 'ready',
    peaksArtifactId: peaks.previewArtifactId,
    spectrogramArtifactId: spectrogram?.status === 'ready' ? spectrogram.previewArtifactId : null,
  };
}

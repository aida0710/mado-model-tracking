/** Derived files the preview worker generates for long audio and for video. */
export const ARTIFACT_PREVIEW_KINDS = ['waveform-peaks', 'spectrogram', 'video-poster'] as const;
export type ArtifactPreviewKind = (typeof ARTIFACT_PREVIEW_KINDS)[number];
export type ArtifactPreviewStatus = 'queued' | 'running' | 'ready' | 'failed' | 'skipped';

/**
 * Browsers decode and analyze audio up to this size themselves (the web viewer's
 * AUDIO_ANALYSIS_MAX_BYTES); header-readable audio above it gets server previews instead.
 */
export const BROWSER_AUDIO_ANALYSIS_MAX_BYTES = 64 * 1024 * 1024;

export interface ArtifactPreview {
  artifactId: string;
  kind: ArtifactPreviewKind;
  status: ArtifactPreviewStatus;
  /** The generated file, an Artifact without a Run; set only when status is 'ready'. */
  previewArtifactId: string | null;
  /** A short code such as render_failed or ffmpeg_unavailable; null unless failed or skipped. */
  error: string | null;
  attempts: number;
  updatedAt: string;
}

/** Content of a 'waveform-peaks' preview Artifact (application/json). */
export interface WaveformPeaksPreview {
  version: 1;
  /** Rate the audio was decoded at; the spectrogram image spans 0 Hz to half of it. */
  sampleRate: number;
  durationSeconds: number;
  samplesPerPeak: number;
  /** Mono mix, one pair per equal slice of the whole file, between -1 and 1. */
  min: number[];
  max: number[];
}

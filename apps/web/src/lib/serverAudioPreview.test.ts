import type { ArtifactPreview } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import { parseWaveformPeaksPreview, summarizeServerAudioPreviews } from './serverAudioPreview';

function preview(overrides: Partial<ArtifactPreview>): ArtifactPreview {
  return {
    artifactId: 'source',
    kind: 'waveform-peaks',
    status: 'queued',
    previewArtifactId: null,
    error: null,
    attempts: 0,
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('サーバー側の音声preview', () => {
  it('peaks JSONを波形に変換し、形の違う文書はnullにする', () => {
    const parsed = parseWaveformPeaksPreview(
      JSON.stringify({ version: 1, sampleRate: 48000, durationSeconds: 3600, samplesPerPeak: 1, min: [-0.5, 0], max: [0.5, 0.25] }),
    );
    expect(parsed?.sampleRate).toBe(48000);
    expect(Array.from(parsed!.peaks.max)).toEqual([0.5, 0.25]);
    expect(parseWaveformPeaksPreview('not json')).toBeNull();
    expect(parseWaveformPeaksPreview(JSON.stringify({ version: 2, sampleRate: 1, durationSeconds: 1, min: [0], max: [0] }))).toBeNull();
    expect(parseWaveformPeaksPreview(JSON.stringify({ version: 1, sampleRate: 1, durationSeconds: 1, min: [0], max: [0, 1] }))).toBeNull();
    expect(parseWaveformPeaksPreview(JSON.stringify({ version: 1, sampleRate: 1, durationSeconds: 1, min: [-2], max: [0] }))).toBeNull();
  });

  it('波形の状態で表示を決め、スペクトログラムが無くても波形は出す', () => {
    expect(summarizeServerAudioPreviews([])).toEqual({ status: 'none' });
    expect(summarizeServerAudioPreviews([preview({ status: 'running' })])).toEqual({ status: 'pending' });
    expect(summarizeServerAudioPreviews([preview({ status: 'failed', error: 'render_failed' })])).toEqual({ status: 'failed' });
    expect(summarizeServerAudioPreviews([preview({ status: 'skipped', error: 'ffmpeg_unavailable' })])).toEqual({ status: 'none' });
    expect(
      summarizeServerAudioPreviews([
        preview({ status: 'ready', previewArtifactId: 'peaks' }),
        preview({ kind: 'spectrogram', status: 'failed' }),
      ]),
    ).toEqual({ status: 'ready', peaksArtifactId: 'peaks', spectrogramArtifactId: null });
    expect(
      summarizeServerAudioPreviews([
        preview({ status: 'ready', previewArtifactId: 'peaks' }),
        preview({ kind: 'spectrogram', status: 'ready', previewArtifactId: 'image' }),
      ]),
    ).toMatchObject({ spectrogramArtifactId: 'image' });
  });
});

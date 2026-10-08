import type { ArtifactMediaInfo } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import { summarizeAudioMedia } from './audioMediaSummary';

const header: ArtifactMediaInfo = {
  artifactId: 'artifact',
  durationSeconds: 2,
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  codec: 'pcm_s16le',
  source: 'header',
};

describe('summarizeAudioMedia', () => {
  it('decode前はヘッダーのmedia情報を表示に使う', () => {
    expect(summarizeAudioMedia(null, header)).toEqual({
      sampleRate: 16000,
      sampleRateFromFile: true,
      channelCount: 1,
      durationSeconds: 2,
    });
  });

  it('decode結果があれば、ヘッダーと食い違ってもdecode結果を使う', () => {
    const decoded = { sampleRate: 48000, sampleRateFromFile: false, channelCount: 2, durationSeconds: 1.9 };
    expect(summarizeAudioMedia(decoded, header)).toBe(decoded);
  });

  it('どちらも無ければ表示しない', () => {
    expect(summarizeAudioMedia(null, null)).toBeNull();
  });
});

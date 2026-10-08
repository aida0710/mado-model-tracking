import { describe, expect, it } from 'vitest';
import { flacFile, waveFile } from '../../test/audioFixtures.js';
import { AUDIO_HEADER_PROBE_BYTES, probeAudioHeader } from './audioHeaderProbe.js';

const probe = (file: Buffer) =>
  probeAudioHeader({ header: file.subarray(0, AUDIO_HEADER_PROBE_BYTES), totalSize: file.length });

describe('probeAudioHeader', () => {
  it('16bit PCMのWAVから長さ・sample rate・チャンネル数を求める', () => {
    expect(probe(waveFile({ sampleRate: 16000, channels: 1, frames: 24000 }))).toEqual({
      durationSeconds: 1.5,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      codec: 'pcm_s16le',
    });
  });

  it('24bit PCMのstereo WAVを読む', () => {
    expect(probe(waveFile({ sampleRate: 48000, channels: 2, bitsPerSample: 24, frames: 96000 }))).toEqual({
      durationSeconds: 2,
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 24,
      codec: 'pcm_s24le',
    });
  });

  it('32bit floatのWAVを読む', () => {
    expect(probe(waveFile({ formatTag: 3, sampleRate: 44100, bitsPerSample: 32, frames: 44100 }))).toMatchObject({
      durationSeconds: 1,
      bitsPerSample: 32,
      codec: 'pcm_f32le',
    });
  });

  it('WAVE_FORMAT_EXTENSIBLEはSubFormatの形式とvalid bitsを使う', () => {
    const file = waveFile({
      channels: 2,
      sampleRate: 48000,
      bitsPerSample: 24,
      frames: 48000,
      extensible: { subFormat: 1, validBits: 20 },
    });
    expect(probe(file)).toEqual({
      durationSeconds: 1,
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 20,
      codec: 'pcm_s24le',
    });
    const float = waveFile({ bitsPerSample: 32, extensible: { subFormat: 3, validBits: 32 } });
    expect(probe(float)?.codec).toBe('pcm_f32le');
  });

  it('FLACのSTREAMINFOからmono・stereoを読む', () => {
    expect(probe(flacFile({ sampleRate: 16000, channels: 1, bitsPerSample: 16, totalSamples: 40000 }))).toEqual({
      durationSeconds: 2.5,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      codec: 'flac',
    });
    expect(probe(flacFile({ sampleRate: 96000, channels: 2, bitsPerSample: 24, totalSamples: 96000 * 3 }))).toEqual({
      durationSeconds: 3,
      sampleRate: 96000,
      channels: 2,
      bitsPerSample: 24,
      codec: 'flac',
    });
  });

  it('data chunkが先頭64KiBより後ろにあれば推測せずnull', () => {
    expect(probe(waveFile({ paddingChunkBytes: AUDIO_HEADER_PROBE_BYTES }))).toBeNull();
  });

  it('data chunkの宣言sizeがファイルの末尾を超える場合は実際に残っているbyte数で求める', () => {
    const file = waveFile({ sampleRate: 8000, frames: 8000 });
    const truncated = file.subarray(0, file.length - 4000);
    expect(probe(truncated)?.durationSeconds).toBe(0.75);
  });

  it('壊れたヘッダー・未対応の形式はnull', () => {
    expect(probe(Buffer.from('0123456789abcdef'))).toBeNull();
    expect(probe(waveFile().subarray(0, 30))).toBeNull();
    // MPEG Layer III inside WAV is compressed and has no fixed frame size.
    expect(probe(waveFile({ formatTag: 0x55 }))).toBeNull();
    const inconsistentBlockAlign = waveFile();
    inconsistentBlockAlign.writeUInt16LE(3, 32);
    expect(probe(inconsistentBlockAlign)).toBeNull();
    expect(probe(waveFile({ sampleRate: 0 }))).toBeNull();
    expect(probe(flacFile({ sampleRate: 16000, channels: 1, bitsPerSample: 16, totalSamples: 0 }))).toBeNull();
    expect(probe(flacFile({ sampleRate: 16000, channels: 1, bitsPerSample: 16, totalSamples: 100 }).subarray(0, 20))).toBeNull();
  });
});

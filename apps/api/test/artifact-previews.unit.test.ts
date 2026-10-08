import { inflateSync } from 'node:zlib';
import { BROWSER_AUDIO_ANALYSIS_MAX_BYTES } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import { previewKindsFor } from '../src/domain/artifactPreviewTargets.js';
import { encodeRgbPng } from '../src/domain/pngEncoder.js';
import {
  SPECTROGRAM_DB_FLOOR,
  SpectrogramAccumulator,
} from '../src/domain/spectrogramAccumulator.js';
import { WaveformPeaksAccumulator } from '../src/domain/waveformPeaksAccumulator.js';
import { parseFfprobeOutput } from '../src/services/mediaProbe.js';

function ffprobeJson(streams: unknown[], format: unknown = { duration: '12.5' }): string {
  return JSON.stringify({ streams, format });
}

const mp3Stream = {
  codec_type: 'audio',
  codec_name: 'mp3',
  sample_rate: '44100',
  channels: 2,
  bits_per_sample: 0,
};

describe('ffprobe出力の検証', () => {
  it('mp3の音声streamから長さ・sample rate・チャンネル数を読み、固定幅の無いcodecのbitsはnull', () => {
    expect(parseFfprobeOutput(ffprobeJson([mp3Stream]))).toEqual({
      durationSeconds: 12.5,
      audio: { codec: 'mp3', sampleRate: 44100, channels: 2, bitsPerSample: null },
      video: null,
    });
  });

  it('FLACはbits_per_raw_sampleを使い、formatに長さが無ければstreamの長さを使う', () => {
    const parsed = parseFfprobeOutput(
      ffprobeJson(
        [{ codec_type: 'audio', codec_name: 'flac', sample_rate: '48000', channels: 1, bits_per_raw_sample: '24', duration: '3.0' }],
        {},
      ),
    );
    expect(parsed).toMatchObject({ durationSeconds: 3, audio: { bitsPerSample: 24 } });
  });

  it('JSONでない出力やstreamsの無い出力はnull', () => {
    expect(parseFfprobeOutput('not json')).toBeNull();
    expect(parseFfprobeOutput('')).toBeNull();
    expect(parseFfprobeOutput('[]')).toBeNull();
    expect(parseFfprobeOutput(JSON.stringify({ format: {} }))).toBeNull();
  });

  it('極端なsample rate・チャンネル数・長さは採用しない', () => {
    const parsed = parseFfprobeOutput(
      ffprobeJson(
        [
          { ...mp3Stream, sample_rate: '99999999' },
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        ],
        { duration: '1e12' },
      ),
    );
    expect(parsed).toEqual({ durationSeconds: null, audio: null, video: { codec: 'h264', width: 1920, height: 1080 } });
    expect(parseFfprobeOutput(ffprobeJson([{ ...mp3Stream, channels: 0 }]))!.audio).toBeNull();
    expect(parseFfprobeOutput(ffprobeJson([{ ...mp3Stream, sample_rate: '-8000' }]))!.audio).toBeNull();
    expect(parseFfprobeOutput(ffprobeJson([mp3Stream], { duration: 'NaN' }))!.durationSeconds).toBeNull();
    expect(parseFfprobeOutput(ffprobeJson([mp3Stream], { duration: '-1' }))!.durationSeconds).toBeNull();
  });

  it('codec名に識別子以外の文字があれば採用せず、カバー画像はvideoとして扱わない', () => {
    expect(parseFfprobeOutput(ffprobeJson([{ ...mp3Stream, codec_name: 'mp3"; DROP' }]))!.audio).toBeNull();
    const withCover = parseFfprobeOutput(
      ffprobeJson([mp3Stream, { codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } }]),
    );
    expect(withCover!.video).toBeNull();
  });
});

describe('preview対象の判定', () => {
  it('ブラウザで解析できる小さなWAV/FLACは対象外で、上限を超えると波形とスペクトログラムを作る', () => {
    expect(previewKindsFor({ mimeType: 'audio/wav', size: 1024, isHeaderProbed: true })).toEqual([]);
    expect(
      previewKindsFor({ mimeType: 'audio/wav', size: BROWSER_AUDIO_ANALYSIS_MAX_BYTES + 1, isHeaderProbed: true }),
    ).toEqual(['waveform-peaks', 'spectrogram']);
  });

  it('ヘッダーで読めない音声は小さくても対象、動画はposter、それ以外と空ファイルは対象外', () => {
    expect(previewKindsFor({ mimeType: 'audio/mpeg', size: 10, isHeaderProbed: false })).toHaveLength(2);
    expect(previewKindsFor({ mimeType: 'video/mp4; codecs=avc1', size: 10, isHeaderProbed: false })).toEqual(['video-poster']);
    expect(previewKindsFor({ mimeType: 'image/png', size: 10, isHeaderProbed: false })).toEqual([]);
    expect(previewKindsFor({ mimeType: 'audio/mpeg', size: 0, isHeaderProbed: false })).toEqual([]);
  });
});

describe('波形peaks', () => {
  it('長さを知らなくても上限数以内に収め、各区間の最小と最大を保つ', () => {
    const accumulator = new WaveformPeaksAccumulator(8);
    const samples = new Float32Array(100).fill(0);
    samples[3] = 0.5;
    samples[97] = -0.75;
    accumulator.add(samples.subarray(0, 37));
    accumulator.add(samples.subarray(37));
    const peaks = accumulator.finish({ sampleRate: 10 });
    expect(peaks.min.length).toBeLessThanOrEqual(8);
    expect(peaks.min.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...peaks.max)).toBe(0.5);
    expect(Math.min(...peaks.min)).toBe(-0.75);
    expect(peaks.max[0]).toBe(0.5);
    expect(peaks.min.at(-1)).toBe(-0.75);
    expect(peaks.durationSeconds).toBe(10);
  });

  it('NaNや範囲外の値は-1〜1に収める', () => {
    const accumulator = new WaveformPeaksAccumulator(4);
    accumulator.add(Float32Array.from([NaN, 3, -4]));
    const peaks = accumulator.finish({ sampleRate: 3 });
    expect(peaks.min).toEqual([0, 1, -1]);
    expect(peaks.max).toEqual([0, 1, -1]);
  });
});

describe('スペクトログラム', () => {
  it('正弦波はその周波数のbinが最も強く、無音はfloorになる', () => {
    const sampleRate = 8000;
    const fftSize = 256;
    const accumulator = new SpectrogramAccumulator({ fftSize, maxColumns: 4 });
    const tone = new Float32Array(sampleRate);
    for (let index = 0; index < tone.length; index += 1)
      tone[index] = Math.sin((2 * Math.PI * 1000 * index) / sampleRate);
    accumulator.add(tone);
    const result = accumulator.finish();
    expect(result.binCount).toBe(fftSize / 2 + 1);
    expect(result.columnCount).toBeLessThanOrEqual(4);
    const firstColumn = Array.from(result.values.subarray(0, result.binCount));
    const loudestBin = firstColumn.indexOf(Math.max(...firstColumn));
    expect(loudestBin).toBe(Math.round((1000 * fftSize) / sampleRate));
    expect(firstColumn[loudestBin]).toBeGreaterThan(-3);

    const silence = new SpectrogramAccumulator({ fftSize });
    silence.add(new Float32Array(fftSize));
    expect(new Set(silence.finish().values)).toEqual(new Set([SPECTROGRAM_DB_FLOOR]));
  });

  it('1フレームに満たない音声も1列になる', () => {
    const accumulator = new SpectrogramAccumulator({ fftSize: 256 });
    accumulator.add(new Float32Array(10).fill(0.1));
    expect(accumulator.finish().columnCount).toBe(1);
  });
});

describe('PNG', () => {
  it('署名・IHDR・画素を正しく書く', () => {
    const png = encodeRgbPng({ width: 2, height: 1, pixels: Uint8Array.from([255, 0, 0, 0, 0, 255]) });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    const idatLength = png.readUInt32BE(33);
    const scanlines = inflateSync(png.subarray(41, 41 + idatLength));
    expect([...scanlines]).toEqual([0, 255, 0, 0, 0, 0, 255]);
  });
});

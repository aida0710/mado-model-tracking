import { describe, expect, it } from 'vitest';
import {
  AUDIO_ANALYSIS_MAX_BYTES,
  SPECTROGRAM_DB_FLOOR,
  STFT_FFT_SIZE,
  canAnalyzeAudio,
  computeSpectrogram,
  computeWaveformPeaks,
  secondsToSampleRange,
  selectChannelSamples,
} from './audioAnalysis';

const SAMPLE_RATE = 16000;

function sine(frequency: number, seconds: number, amplitude = 1): Float32Array {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
  return samples;
}

function loudestBin(values: Float32Array, binCount: number, frame: number): number {
  let best = 0;
  for (let bin = 1; bin < binCount; bin += 1)
    if (values[frame * binCount + bin]! > values[frame * binCount + best]!) best = bin;
  return best;
}

describe('STFTスペクトログラム', () => {
  it('16kHzの440Hz正弦波は、線形スケールで440Hzのbin（28）が最大になり、満振幅でほぼ0dBになる', () => {
    const spectrogram = computeSpectrogram(sine(440, 1), { sampleRate: SAMPLE_RATE });
    expect(spectrogram.binCount).toBe(STFT_FFT_SIZE / 2 + 1);
    expect(spectrogram.hopSize).toBe(256);
    expect(spectrogram.frameCount).toBe(Math.floor((SAMPLE_RATE - STFT_FFT_SIZE) / 256) + 1);
    const expectedBin = Math.round((440 * STFT_FFT_SIZE) / SAMPLE_RATE);
    const middle = Math.floor(spectrogram.frameCount / 2);
    expect(loudestBin(spectrogram.values, spectrogram.binCount, middle)).toBe(expectedBin);
    expect(spectrogram.values[middle * spectrogram.binCount + expectedBin]).toBeGreaterThan(-3);
  });

  it('melスケールでも440Hzを含む帯域が最大になり、帯域数が指定どおりになる', () => {
    const spectrogram = computeSpectrogram(sine(440, 1), { sampleRate: SAMPLE_RATE, scale: 'mel', melBandCount: 40 });
    expect(spectrogram.binCount).toBe(40);
    const band = loudestBin(spectrogram.values, spectrogram.binCount, 10);
    const mel = (hertz: number) => 2595 * Math.log10(1 + hertz / 700);
    const centerHertz = 700 * (10 ** ((mel(SAMPLE_RATE / 2) * (band + 1)) / 41 / 2595) - 1);
    expect(Math.abs(centerHertz - 440)).toBeLessThan(80);
  });

  it('無音はすべてdBの下限になる', () => {
    const spectrogram = computeSpectrogram(new Float32Array(SAMPLE_RATE), { sampleRate: SAMPLE_RATE });
    expect(spectrogram.frameCount).toBeGreaterThan(0);
    expect(spectrogram.values.every((value) => value === SPECTROGRAM_DB_FLOOR)).toBe(true);
  });

  it('長い範囲はフレーム数を上限に抑え、hopを広げて範囲全体を覆う', () => {
    const samples = sine(440, 60);
    const spectrogram = computeSpectrogram(samples, { sampleRate: SAMPLE_RATE, maxFrames: 500 });
    expect(spectrogram.frameCount).toBe(500);
    expect(spectrogram.hopSize).toBeGreaterThan(256);
    expect((spectrogram.frameCount - 1) * spectrogram.hopSize + STFT_FFT_SIZE).toBeLessThanOrEqual(samples.length);
    expect((spectrogram.frameCount - 1) * spectrogram.hopSize).toBeGreaterThan(samples.length * 0.99 - STFT_FFT_SIZE);
  });

  it('FFT長より短い音声はフレームを作らない', () => {
    expect(computeSpectrogram(new Float32Array(100), { sampleRate: SAMPLE_RATE }).frameCount).toBe(0);
  });
});

describe('波形のpeaks', () => {
  it('各区間の最小値と最大値を返す', () => {
    const samples = Float32Array.from([0.1, -0.5, 0.3, 0.9, -0.2, -0.8, 0.0, 0.4]);
    const peaks = computeWaveformPeaks(samples, 2);
    expect(Array.from(peaks.min)).toEqual([Math.fround(-0.5), Math.fround(-0.8)]);
    expect(Array.from(peaks.max)).toEqual([Math.fround(0.9), Math.fround(0.4)]);
  });

  it('サンプル数より区間が多くても、空の区間を作らず値を持つ', () => {
    const peaks = computeWaveformPeaks(Float32Array.from([0.5, -0.5]), 4);
    expect(Array.from(peaks.max)).toEqual([0.5, 0.5, -0.5, -0.5]);
  });

  it('正弦波の全体のpeaksは振幅に一致する', () => {
    const peaks = computeWaveformPeaks(sine(440, 1, 0.5), 10);
    for (let bucket = 0; bucket < 10; bucket += 1) {
      expect(peaks.max[bucket]).toBeCloseTo(0.5, 2);
      expect(peaks.min[bucket]).toBeCloseTo(-0.5, 2);
    }
  });
});

describe('チャンネル選択と範囲', () => {
  it('mixはチャンネルの平均、番号はそのチャンネルを返す', () => {
    const left = Float32Array.from([1, 0.5]);
    const right = Float32Array.from([-1, 0.5]);
    expect(Array.from(selectChannelSamples([left, right], 'mix'))).toEqual([0, 0.5]);
    expect(selectChannelSamples([left, right], 1)).toBe(right);
    expect(() => selectChannelSamples([left], 2)).toThrow(RangeError);
  });

  it('秒の範囲をサンプル数の内側に丸める', () => {
    expect(secondsToSampleRange({ startSeconds: -1, endSeconds: 0.5 }, SAMPLE_RATE, 4000)).toEqual({ start: 0, end: 4000 });
    expect(secondsToSampleRange({ startSeconds: 0.1, endSeconds: 0.2 }, SAMPLE_RATE, 16000)).toEqual({ start: 1600, end: 3200 });
  });
});

describe('解析の上限', () => {
  it('64MiBまでは解析し、超えると再生だけにする', () => {
    expect(AUDIO_ANALYSIS_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(canAnalyzeAudio(AUDIO_ANALYSIS_MAX_BYTES)).toBe(true);
    expect(canAnalyzeAudio(AUDIO_ANALYSIS_MAX_BYTES + 1)).toBe(false);
  });
});

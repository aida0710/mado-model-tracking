// Pure audio analysis for the artifact viewer: waveform peaks and STFT spectrograms (linear or mel).
// Runs inside workers/audioAnalysis.worker.ts and in unit tests, so it must not touch the DOM.

import { BROWSER_AUDIO_ANALYSIS_MAX_BYTES } from '@mmt/contracts';

/**
 * The viewer fetches the whole file and decodes it into Float32 PCM. Decoded PCM is several times
 * the compressed size (a 64MiB MP3 can expand past 1GiB at 48kHz stereo), and a browser tab is
 * usually killed around 2-4GiB, so files above this size are played without analysis. The server
 * makes previews above the same size.
 */
export const AUDIO_ANALYSIS_MAX_BYTES = BROWSER_AUDIO_ANALYSIS_MAX_BYTES;
export const STFT_FFT_SIZE = 1024;
// Minimum hop. Long ranges use a larger hop so the frame count stays near the drawn width.
export const STFT_HOP_SIZE = 256;
// A spectrogram never needs more columns than a wide canvas has pixels.
export const SPECTROGRAM_MAX_FRAMES = 2048;
// Quieter bins are clamped here so silence draws as the darkest color instead of -Infinity.
export const SPECTROGRAM_DB_FLOOR = -100;
export const MEL_BAND_COUNT = 80;

export type SpectrogramScale = 'linear' | 'mel';
/** 'mix' averages all channels; a number selects one channel (0-based). */
export type AudioChannelSelection = 'mix' | number;

export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
}

export interface Spectrogram {
  frameCount: number;
  binCount: number;
  hopSize: number;
  /** Row-major frames: values[frame * binCount + bin], in dB between SPECTROGRAM_DB_FLOOR and 0. */
  values: Float32Array;
  /** Highest frequency the last bin represents (Nyquist). */
  maxFrequency: number;
}

export function canAnalyzeAudio(sizeBytes: number): boolean {
  return sizeBytes <= AUDIO_ANALYSIS_MAX_BYTES;
}

export function selectChannelSamples(
  channels: readonly Float32Array[],
  selection: AudioChannelSelection,
): Float32Array {
  if (selection !== 'mix') {
    const channel = channels[selection];
    if (!channel) throw new RangeError(`Channel ${selection} does not exist`);
    return channel;
  }
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const mixed = new Float32Array(first.length);
  for (const channel of channels)
    for (let index = 0; index < mixed.length; index += 1) mixed[index]! += channel[index] ?? 0;
  for (let index = 0; index < mixed.length; index += 1) mixed[index]! /= channels.length;
  return mixed;
}

/** Minimum and maximum sample of each of `bucketCount` equal slices. Empty slices read as 0. */
export function computeWaveformPeaks(samples: Float32Array, bucketCount: number): WaveformPeaks {
  const count = Math.max(0, Math.floor(bucketCount));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  if (samples.length === 0) return { min, max };
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor((bucket * samples.length) / count);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * samples.length) / count));
    let low = Infinity;
    let high = -Infinity;
    for (let index = start; index < end && index < samples.length; index += 1) {
      const value = samples[index]!;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    min[bucket] = Number.isFinite(low) ? low : 0;
    max[bucket] = Number.isFinite(high) ? high : 0;
  }
  return { min, max };
}

export function createHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index += 1)
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
  return window;
}

/** In-place iterative radix-2 FFT. `real.length` must be a power of two. */
export function fftInPlace(real: Float32Array, imaginary: Float32Array): void {
  const size = real.length;
  if ((size & (size - 1)) !== 0) throw new RangeError('FFT size must be a power of two');
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed]!, real[index]!];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed]!, imaginary[index]!];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

/** Power ratio to dB, clamped to `floorDb`. A reference of 1 means full scale reads 0dB. */
export function powerToDecibels(power: number, floorDb = SPECTROGRAM_DB_FLOOR): number {
  if (!(power > 0)) return floorDb;
  return Math.max(floorDb, Math.min(0, 10 * Math.log10(power)));
}

const hertzToMel = (hertz: number) => 2595 * Math.log10(1 + hertz / 700);
const melToHertz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/** Triangular HTK mel filters over the `fftSize / 2 + 1` linear bins. filters[band][bin]. */
export function createMelFilterBank(
  sampleRate: number,
  fftSize: number,
  bandCount: number,
): Float32Array[] {
  const binCount = fftSize / 2 + 1;
  const maxMel = hertzToMel(sampleRate / 2);
  const edges = Array.from({ length: bandCount + 2 }, (_, index) =>
    melToHertz((maxMel * index) / (bandCount + 1)),
  );
  const binFrequency = (bin: number) => (bin * sampleRate) / fftSize;
  return Array.from({ length: bandCount }, (_, band) => {
    const [low, center, high] = [edges[band]!, edges[band + 1]!, edges[band + 2]!];
    const filter = new Float32Array(binCount);
    for (let bin = 0; bin < binCount; bin += 1) {
      const frequency = binFrequency(bin);
      if (frequency > low && frequency < high)
        filter[bin] =
          frequency <= center ? (frequency - low) / (center - low) : (high - frequency) / (high - center);
    }
    return filter;
  });
}

export interface SpectrogramOptions {
  sampleRate: number;
  scale?: SpectrogramScale;
  fftSize?: number;
  hopSize?: number;
  maxFrames?: number;
  melBandCount?: number;
}

/**
 * Hann-windowed STFT power spectrogram in dB. A full-scale sine reads about 0dB because the power is
 * normalized by the window's coherent gain. When the range would yield more than `maxFrames`
 * frames, the hop grows so the frames stay evenly spread across the whole range.
 */
export function computeSpectrogram(samples: Float32Array, options: SpectrogramOptions): Spectrogram {
  const fftSize = options.fftSize ?? STFT_FFT_SIZE;
  const maxFrames = options.maxFrames ?? SPECTROGRAM_MAX_FRAMES;
  const scale = options.scale ?? 'linear';
  const linearBinCount = fftSize / 2 + 1;
  const minimumHop = options.hopSize ?? STFT_HOP_SIZE;
  const naturalFrames = Math.max(0, Math.floor((samples.length - fftSize) / minimumHop) + 1);
  const frameCount = Math.min(naturalFrames, maxFrames);
  const hopSize =
    naturalFrames > maxFrames && frameCount > 1
      ? Math.floor((samples.length - fftSize) / (frameCount - 1))
      : minimumHop;
  const window = createHannWindow(fftSize);
  const windowSum = window.reduce((sum, value) => sum + value, 0);
  // |X|^2 of a full-scale sine is (windowSum / 2)^2, so this maps it to a power ratio of 1.
  const powerReference = (windowSum / 2) ** 2;
  const melFilters =
    scale === 'mel'
      ? createMelFilterBank(options.sampleRate, fftSize, options.melBandCount ?? MEL_BAND_COUNT)
      : null;
  const binCount = melFilters ? melFilters.length : linearBinCount;
  const values = new Float32Array(frameCount * binCount);
  const real = new Float32Array(fftSize);
  const imaginary = new Float32Array(fftSize);
  const power = new Float32Array(linearBinCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * hopSize;
    for (let index = 0; index < fftSize; index += 1) {
      real[index] = (samples[offset + index] ?? 0) * window[index]!;
      imaginary[index] = 0;
    }
    fftInPlace(real, imaginary);
    for (let bin = 0; bin < linearBinCount; bin += 1)
      power[bin] = (real[bin]! ** 2 + imaginary[bin]! ** 2) / powerReference;
    for (let bin = 0; bin < binCount; bin += 1) {
      const filter = melFilters?.[bin];
      let bandPower = 0;
      if (filter) for (let linear = 0; linear < linearBinCount; linear += 1) bandPower += filter[linear]! * power[linear]!;
      else bandPower = power[bin]!;
      values[frame * binCount + bin] = powerToDecibels(bandPower);
    }
  }
  return { frameCount, binCount, hopSize, values, maxFrequency: options.sampleRate / 2 };
}

/** Converts a time range in seconds to clamped sample indexes [start, end). */
export function secondsToSampleRange(
  range: { startSeconds: number; endSeconds: number },
  sampleRate: number,
  sampleCount: number,
): { start: number; end: number } {
  const clamp = (value: number) => Math.min(sampleCount, Math.max(0, Math.round(value * sampleRate)));
  const start = clamp(range.startSeconds);
  return { start, end: Math.max(start, clamp(range.endSeconds)) };
}

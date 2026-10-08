import type { WaveformPeaksPreview } from '@mmt/contracts';

// Far more than a canvas is wide, so the viewer can zoom into an overview without refetching.
export const WAVEFORM_PEAKS_MAX_COUNT = 8192;
// Four decimals keep the JSON small; a pixel column cannot show finer amplitude steps.
const PEAK_DECIMALS = 4;

function roundPeak(value: number): number {
  return Number(value.toFixed(PEAK_DECIMALS));
}

function clampSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Streams mono samples into min/max peaks without knowing the length in advance. Each peak starts
 * at one sample; when the count reaches `maxCount`, neighbouring peaks are merged and the samples
 * per peak double, so memory stays constant and the result has between maxCount/2 and maxCount
 * peaks (fewer only for very short audio).
 */
export class WaveformPeaksAccumulator {
  private readonly min: number[] = [];
  private readonly max: number[] = [];
  private samplesPerPeak = 1;
  private currentCount = 0;
  private currentMin = Infinity;
  private currentMax = -Infinity;
  private totalSamples = 0;

  constructor(private readonly maxCount = WAVEFORM_PEAKS_MAX_COUNT) {
    if (maxCount < 2 || maxCount % 2 !== 0) throw new RangeError('maxCount must be an even number ≥ 2');
  }

  add(samples: Float32Array): void {
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index]!;
      if (value < this.currentMin) this.currentMin = value;
      if (value > this.currentMax) this.currentMax = value;
      this.currentCount += 1;
      if (this.currentCount === this.samplesPerPeak) this.closeCurrentPeak();
    }
    this.totalSamples += samples.length;
  }

  finish(audio: { sampleRate: number }): WaveformPeaksPreview {
    if (this.currentCount > 0) this.closeCurrentPeak();
    return {
      version: 1,
      sampleRate: audio.sampleRate,
      durationSeconds: this.totalSamples / audio.sampleRate,
      samplesPerPeak: this.samplesPerPeak,
      min: this.min.map(roundPeak),
      max: this.max.map(roundPeak),
    };
  }

  private closeCurrentPeak(): void {
    // NaN samples never update the extremes; such a slice reads as silence.
    this.min.push(Number.isFinite(this.currentMin) ? clampSample(this.currentMin) : 0);
    this.max.push(Number.isFinite(this.currentMax) ? clampSample(this.currentMax) : 0);
    this.currentCount = 0;
    this.currentMin = Infinity;
    this.currentMax = -Infinity;
    if (this.min.length === this.maxCount) this.halveResolution();
  }

  private halveResolution(): void {
    for (let peak = 0; peak < this.maxCount / 2; peak += 1) {
      this.min[peak] = Math.min(this.min[2 * peak]!, this.min[2 * peak + 1]!);
      this.max[peak] = Math.max(this.max[2 * peak]!, this.max[2 * peak + 1]!);
    }
    this.min.length = this.maxCount / 2;
    this.max.length = this.maxCount / 2;
    this.samplesPerPeak *= 2;
  }
}

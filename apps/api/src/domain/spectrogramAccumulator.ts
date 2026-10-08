// Same window and floor as the web viewer (apps/web/src/lib/audioAnalysis.ts), so a server image
// and a browser-drawn spectrogram of the same file look alike.
export const SPECTROGRAM_FFT_SIZE = 1024;
export const SPECTROGRAM_DB_FLOOR = -100;
// One column per pixel of a wide canvas; the image is stretched to the drawn width.
export const SPECTROGRAM_MAX_COLUMNS = 2048;

export interface SpectrogramDecibels {
  columnCount: number;
  /** fftSize / 2 + 1 linear bins from 0 Hz to Nyquist. */
  binCount: number;
  /** Column-major: values[column * binCount + bin], between SPECTROGRAM_DB_FLOOR and 0. */
  values: Float32Array;
}

function createHannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let index = 0; index < size; index += 1)
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
  return window;
}

interface TwiddleTable {
  cos: Float64Array;
  sin: Float64Array;
}

/** cos/sin of -2πk/size for k < size/2, so the FFT never calls Math.cos per butterfly. */
function createTwiddleTable(size: number): TwiddleTable {
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let index = 0; index < size / 2; index += 1) {
    cos[index] = Math.cos((-2 * Math.PI * index) / size);
    sin[index] = Math.sin((-2 * Math.PI * index) / size);
  }
  return { cos, sin };
}

/** In-place iterative radix-2 FFT; `real.length` must be the power of two the table was made for. */
function fft(real: Float64Array, imaginary: Float64Array, twiddles: TwiddleTable): void {
  const size = real.length;
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
    const stride = size / length;
    for (let start = 0; start < size; start += length)
      for (let offset = 0; offset < length / 2; offset += 1) {
        const twiddleReal = twiddles.cos[offset * stride]!;
        const twiddleImaginary = twiddles.sin[offset * stride]!;
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
      }
  }
}

/**
 * Streams mono samples into an averaged power spectrogram of the whole file without holding the
 * audio. Non-overlapping Hann frames are summed into columns; when the column count reaches
 * `maxColumns`, neighbouring columns merge, as in WaveformPeaksAccumulator.
 */
export class SpectrogramAccumulator {
  private readonly binCount: number;
  private readonly window: Float64Array;
  private readonly twiddles: TwiddleTable;
  private readonly powerReference: number;
  private readonly frame: Float64Array;
  private readonly real: Float64Array;
  private readonly imaginary: Float64Array;
  private readonly columnPower: Float64Array;
  private readonly columnFrames: Uint32Array;
  private frameFill = 0;
  private framesPerColumn = 1;
  private columnCount = 0;
  private framesInCurrentColumn = 0;
  private hasFrames = false;

  constructor(
    private readonly options: { fftSize?: number; maxColumns?: number } = {},
  ) {
    const fftSize = options.fftSize ?? SPECTROGRAM_FFT_SIZE;
    const maxColumns = options.maxColumns ?? SPECTROGRAM_MAX_COLUMNS;
    if (!Number.isInteger(Math.log2(fftSize))) throw new RangeError('fftSize must be a power of two');
    if (maxColumns < 2 || maxColumns % 2 !== 0) throw new RangeError('maxColumns must be an even number ≥ 2');
    this.binCount = fftSize / 2 + 1;
    this.window = createHannWindow(fftSize);
    this.twiddles = createTwiddleTable(fftSize);
    const windowSum = this.window.reduce((sum, value) => sum + value, 0);
    // |X|^2 of a full-scale sine is (windowSum / 2)^2, so full scale reads about 0 dB.
    this.powerReference = (windowSum / 2) ** 2;
    this.frame = new Float64Array(fftSize);
    this.real = new Float64Array(fftSize);
    this.imaginary = new Float64Array(fftSize);
    this.columnPower = new Float64Array(maxColumns * this.binCount);
    this.columnFrames = new Uint32Array(maxColumns);
  }

  private get maxColumns(): number {
    return this.columnFrames.length;
  }

  add(samples: Float32Array): void {
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index]!;
      this.frame[this.frameFill] = Number.isFinite(value) ? value : 0;
      this.frameFill += 1;
      if (this.frameFill === this.frame.length) this.addFrame();
    }
  }

  finish(): SpectrogramDecibels {
    // Audio shorter than one frame still yields one zero-padded column; a longer tail is dropped.
    if (!this.hasFrames && this.frameFill > 0) {
      this.frame.fill(0, this.frameFill);
      this.addFrame();
    }
    const columnCount = this.columnCount + (this.framesInCurrentColumn > 0 ? 1 : 0);
    const values = new Float32Array(columnCount * this.binCount);
    for (let column = 0; column < columnCount; column += 1) {
      const frames = this.columnFrames[column]!;
      for (let bin = 0; bin < this.binCount; bin += 1) {
        const power = frames > 0 ? this.columnPower[column * this.binCount + bin]! / frames : 0;
        values[column * this.binCount + bin] =
          power > 0
            ? Math.max(SPECTROGRAM_DB_FLOOR, Math.min(0, 10 * Math.log10(power)))
            : SPECTROGRAM_DB_FLOOR;
      }
    }
    return { columnCount, binCount: this.binCount, values };
  }

  private addFrame(): void {
    this.frameFill = 0;
    this.hasFrames = true;
    for (let index = 0; index < this.frame.length; index += 1) {
      this.real[index] = this.frame[index]! * this.window[index]!;
      this.imaginary[index] = 0;
    }
    fft(this.real, this.imaginary, this.twiddles);
    const offset = this.columnCount * this.binCount;
    for (let bin = 0; bin < this.binCount; bin += 1)
      this.columnPower[offset + bin]! +=
        (this.real[bin]! ** 2 + this.imaginary[bin]! ** 2) / this.powerReference;
    this.columnFrames[this.columnCount]! += 1;
    this.framesInCurrentColumn += 1;
    if (this.framesInCurrentColumn < this.framesPerColumn) return;
    this.framesInCurrentColumn = 0;
    this.columnCount += 1;
    if (this.columnCount === this.maxColumns) this.halveResolution();
  }

  private halveResolution(): void {
    const half = this.maxColumns / 2;
    for (let column = 0; column < half; column += 1) {
      for (let bin = 0; bin < this.binCount; bin += 1)
        this.columnPower[column * this.binCount + bin] =
          this.columnPower[2 * column * this.binCount + bin]! +
          this.columnPower[(2 * column + 1) * this.binCount + bin]!;
      this.columnFrames[column] = this.columnFrames[2 * column]! + this.columnFrames[2 * column + 1]!;
    }
    this.columnPower.fill(0, half * this.binCount);
    this.columnFrames.fill(0, half);
    this.columnCount = half;
    this.framesPerColumn *= 2;
  }
}

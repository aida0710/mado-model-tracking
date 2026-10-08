import type { WaveformPeaksPreview } from '@mmt/contracts';
import { SpectrogramAccumulator } from '../domain/spectrogramAccumulator.js';
import { renderSpectrogramPng } from '../domain/spectrogramImage.js';
import { WaveformPeaksAccumulator } from '../domain/waveformPeaksAccumulator.js';
import { MediaToolFailedError, runMediaTool } from './mediaTools.js';

const FLOAT32_BYTES = 4;
// Wide enough for a detail view; larger frames only make the poster slower to load.
const POSTER_MAX_WIDTH = 1280;
// Skips black lead-in frames without seeking past the end of short clips.
const POSTER_SEEK_SECONDS = 1;
const POSTER_SEEK_FRACTION = 0.1;
// A PNG of a 1280-wide frame is a few MiB at most.
const POSTER_MAX_BYTES = 32 * 1024 * 1024;

export interface MediaToolPaths {
  ffmpegPath: string;
  timeoutMs: number;
}

export interface AudioPreviews {
  peaks: WaveformPeaksPreview;
  spectrogramPng: Buffer;
}

/** Splits a byte stream into Float32 samples, carrying a partial sample over to the next chunk. */
function float32Reader(onSamples: (samples: Float32Array) => void): (chunk: Buffer) => void {
  let carry = Buffer.alloc(0);
  return (chunk) => {
    const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const usable = bytes.length - (bytes.length % FLOAT32_BYTES);
    carry = Buffer.from(bytes.subarray(usable));
    // Copy so the Float32Array is aligned regardless of the chunk's offset in its pool.
    const aligned = new Uint8Array(bytes.subarray(0, usable));
    onSamples(new Float32Array(aligned.buffer, 0, usable / FLOAT32_BYTES));
  };
}

/**
 * Decodes the first audio stream once, as a mono mix at its own sample rate, and streams it into
 * both the peaks and the spectrogram so a multi-GB file never sits in memory.
 */
export async function renderAudioPreviews(render: {
  tools: MediaToolPaths;
  filePath: string;
  sampleRate: number;
}): Promise<AudioPreviews> {
  const peaks = new WaveformPeaksAccumulator();
  const spectrogram = new SpectrogramAccumulator();
  await runMediaTool({
    command: render.tools.ffmpegPath,
    args: [
      '-v', 'error', '-nostdin', '-i', render.filePath,
      '-map', '0:a:0', '-ac', '1', '-ar', String(render.sampleRate), '-f', 'f32le', 'pipe:1',
    ],
    timeoutMs: render.tools.timeoutMs,
    onStdout: float32Reader((samples) => {
      peaks.add(samples);
      spectrogram.add(samples);
    }),
  });
  const result = peaks.finish({ sampleRate: render.sampleRate });
  if (result.min.length === 0) throw new MediaToolFailedError('output');
  return { peaks: result, spectrogramPng: renderSpectrogramPng(spectrogram.finish()) };
}

export async function renderVideoPoster(render: {
  tools: MediaToolPaths;
  filePath: string;
  durationSeconds: number | null;
  width: number;
}): Promise<Buffer> {
  const seekSeconds = Math.min(
    POSTER_SEEK_SECONDS,
    (render.durationSeconds ?? 0) * POSTER_SEEK_FRACTION,
  );
  const poster = await runMediaTool({
    command: render.tools.ffmpegPath,
    args: [
      '-v', 'error', '-nostdin', '-ss', seekSeconds.toFixed(3), '-i', render.filePath,
      '-map', '0:v:0', '-frames:v', '1',
      ...(render.width > POSTER_MAX_WIDTH ? ['-vf', `scale=${POSTER_MAX_WIDTH}:-2`] : []),
      '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
    ],
    timeoutMs: render.tools.timeoutMs,
    maxOutputBytes: POSTER_MAX_BYTES,
  });
  if (poster.length === 0) throw new MediaToolFailedError('output');
  return poster;
}

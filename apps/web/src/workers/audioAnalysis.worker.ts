// Computes waveform peaks and spectrograms off the main thread. The main thread decodes (Web Audio
// decoding is not available in workers), then transfers the PCM here once; each view change only
// sends a small request, so zooming and channel switches never copy the audio again.
import {
  computeSpectrogram,
  computeWaveformPeaks,
  secondsToSampleRange,
  selectChannelSamples,
  type AudioChannelSelection,
  type Spectrogram,
  type SpectrogramScale,
  type WaveformPeaks,
} from '../lib/audioAnalysis';
import type { TimeRange } from '../lib/audioTimeline';

export interface AudioAnalysisLoadMessage {
  type: 'load';
  channels: Float32Array[];
  sampleRate: number;
}
export interface AudioAnalysisView {
  channel: AudioChannelSelection;
  /** null analyzes the whole file. */
  range: TimeRange | null;
  /** Drawn width in device pixels; peaks get one bucket per column. */
  columns: number;
  scale: SpectrogramScale;
}
export interface AudioAnalysisRequestMessage extends AudioAnalysisView {
  type: 'analyze';
  requestId: number;
}
export type AudioAnalysisResponse =
  | { requestId: number; peaks: WaveformPeaks; spectrogram: Spectrogram }
  | { requestId: number; error: string };

// The DOM lib types `self` as Window; this file only needs the worker side of postMessage.
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<AudioAnalysisLoadMessage | AudioAnalysisRequestMessage>) => void) | null;
  postMessage: (message: AudioAnalysisResponse, transfer: Transferable[]) => void;
};

let channels: Float32Array[] = [];
let sampleRate = 0;
// Mixing a long stereo file costs a full pass, so the mix is kept for later requests.
let mixedSamples: Float32Array | null = null;

function samplesFor(selection: AudioChannelSelection): Float32Array {
  if (selection !== 'mix') return selectChannelSamples(channels, selection);
  mixedSamples ??= selectChannelSamples(channels, 'mix');
  return mixedSamples;
}

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'load') {
    channels = message.channels;
    sampleRate = message.sampleRate;
    mixedSamples = null;
    return;
  }
  try {
    const samples = samplesFor(message.channel);
    const range = message.range
      ? secondsToSampleRange(message.range, sampleRate, samples.length)
      : { start: 0, end: samples.length };
    const visible = samples.subarray(range.start, range.end);
    const peaks = computeWaveformPeaks(visible, message.columns);
    const spectrogram = computeSpectrogram(visible, {
      sampleRate,
      scale: message.scale,
      maxFrames: message.columns,
    });
    workerScope.postMessage({ requestId: message.requestId, peaks, spectrogram }, [
      peaks.min.buffer,
      peaks.max.buffer,
      spectrogram.values.buffer,
    ]);
  } catch (error) {
    workerScope.postMessage(
      { requestId: message.requestId, error: error instanceof Error ? error.message : String(error) },
      [],
    );
  }
};

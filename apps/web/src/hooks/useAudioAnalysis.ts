import { useEffect, useRef, useState } from 'react';
import { canAnalyzeAudio, type Spectrogram, type WaveformPeaks } from '../lib/audioAnalysis';
import { readAudioSampleRate } from '../lib/audioSampleRate';
import type {
  AudioAnalysisResponse,
  AudioAnalysisView,
} from '../workers/audioAnalysis.worker';

export interface DecodedAudioInfo {
  sampleRate: number;
  /** False when the container header was unreadable and the rate is the decoder's output rate. */
  sampleRateFromFile: boolean;
  channelCount: number;
  durationSeconds: number;
}
export type AudioAnalysisState =
  | { status: 'too_large' }
  | { status: 'loading' }
  | { status: 'error'; reason: 'fetch' | 'decode' | 'analysis' }
  | {
      status: 'ready';
      info: DecodedAudioInfo;
      analysis: { peaks: WaveformPeaks; spectrogram: Spectrogram; view: AudioAnalysisView } | null;
    };

// OfflineAudioContext accepts 3kHz to 768kHz; other header values are treated as unreadable.
const MIN_DECODE_SAMPLE_RATE = 3000;
const MAX_DECODE_SAMPLE_RATE = 768000;

async function fetchArtifactBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function decodeAudio(bytes: ArrayBuffer): Promise<{ buffer: AudioBuffer; sampleRateFromFile: boolean }> {
  const headerRate = readAudioSampleRate(bytes);
  const usable =
    headerRate !== null && headerRate >= MIN_DECODE_SAMPLE_RATE && headerRate <= MAX_DECODE_SAMPLE_RATE;
  // A context at the file's own rate makes decodeAudioData return the samples without resampling.
  const context = usable ? new OfflineAudioContext(1, 1, headerRate) : new AudioContext();
  try {
    return { buffer: await context.decodeAudioData(bytes), sampleRateFromFile: usable };
  } finally {
    if (context instanceof AudioContext) void context.close();
  }
}

class StageError extends Error {
  constructor(readonly reason: 'fetch' | 'decode') {
    super(reason);
  }
}

/**
 * Fetches, decodes, and analyzes an audio Artifact for the visible view. Files over
 * AUDIO_ANALYSIS_MAX_BYTES are never fetched here (see lib/audioAnalysis.ts); the viewer streams
 * them through <audio> and draws the server's previews (useServerAudioPreview) instead. `view` null
 * waits until the drawn width is known.
 */
export function useAudioAnalysis({
  url,
  sizeBytes,
  view,
}: {
  url: string;
  sizeBytes: number;
  view: AudioAnalysisView | null;
}): AudioAnalysisState & { retry: () => void } {
  const analyzable = canAnalyzeAudio(sizeBytes);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AudioAnalysisState>({ status: 'loading' });
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!analyzable) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      try {
        const bytes = await fetchArtifactBytes(url, controller.signal).catch((error: unknown) => {
          throw controller.signal.aborted ? error : new StageError('fetch');
        });
        const { buffer, sampleRateFromFile } = await decodeAudio(bytes).catch(() => {
          throw new StageError('decode');
        });
        if (controller.signal.aborted) return;
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
          buffer.getChannelData(index).slice(),
        );
        const worker = new Worker(new URL('../workers/audioAnalysis.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.postMessage(
          { type: 'load', channels, sampleRate: buffer.sampleRate },
          channels.map((channel) => channel.buffer),
        );
        workerRef.current = worker;
        setState({
          status: 'ready',
          info: {
            sampleRate: buffer.sampleRate,
            sampleRateFromFile,
            channelCount: buffer.numberOfChannels,
            durationSeconds: buffer.duration,
          },
          analysis: null,
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({ status: 'error', reason: error instanceof StageError ? error.reason : 'fetch' });
      }
    })();
    return () => {
      controller.abort();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [url, analyzable, revision]);

  const ready = state.status === 'ready';
  const viewKey = view ? JSON.stringify(view) : null;
  useEffect(() => {
    const worker = workerRef.current;
    if (!ready || !worker || !view) return;
    // Only the newest request is drawn; answers to superseded views are dropped.
    const requestId = ++requestIdRef.current;
    const listener = (event: MessageEvent<AudioAnalysisResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;
      setState((previous) => {
        if (previous.status !== 'ready') return previous;
        if ('error' in response) return { status: 'error', reason: 'analysis' };
        return { ...previous, analysis: { peaks: response.peaks, spectrogram: response.spectrogram, view } };
      });
    };
    worker.addEventListener('message', listener);
    worker.postMessage({ type: 'analyze', requestId, ...view });
    return () => worker.removeEventListener('message', listener);
    // viewKey stands for `view`, whose object identity changes on every render.
  }, [ready, viewKey]);

  const retry = () => setRevision((value) => value + 1);
  return analyzable ? { ...state, retry } : { status: 'too_large', retry };
}

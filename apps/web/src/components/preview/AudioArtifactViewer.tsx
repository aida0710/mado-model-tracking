import { useEffect, useState, type PointerEvent } from 'react';
import type { Artifact } from '@mmt/contracts';
import { Pause, Play, Repeat, X, ZoomIn, ZoomOut } from 'lucide-react';
import { trackingApi } from '../../api/tracking';
import { useArtifactMediaInfo } from '../../hooks/useArtifactMediaInfo';
import { useAudioAnalysis } from '../../hooks/useAudioAnalysis';
import { useAudioPlayback, type LoopRange } from '../../hooks/useAudioPlayback';
import { useServerAudioPreview, type ServerAudioPreviewState } from '../../hooks/useServerAudioPreview';
import { summarizeAudioMedia, type AudioMediaSummary } from '../../lib/audioMediaSummary';
import { SPECTROGRAM_MAX_FRAMES, type AudioChannelSelection, type SpectrogramScale } from '../../lib/audioAnalysis';
import {
  ZOOM_STEP,
  clampTimeRange,
  formatAudioTime,
  fractionOfTime,
  loopRangeBetween,
  timeAtFraction,
  zoomTimeRange,
  type TimeRange,
} from '../../lib/audioTimeline';
import { ErrorNotice, Loading } from '../Feedback';
import { text } from '../../i18n/catalog';
import { artifactsTextTemplates } from '../../i18n/artifacts';
import { AudioPreviewOverview } from './AudioPreviewOverview';
import { AudioSpectrogram } from './AudioSpectrogram';
import { AudioWaveform } from './AudioWaveform';

const WAVEFORM_HEIGHT = 88;
const SPECTROGRAM_HEIGHT = 140;
// The Nyquist label sits just inside the spectrogram's top edge.
const FREQUENCY_LABEL_OFFSET = 6;
// Pointer travel below this is a click (seek); more is a drag that sets the loop range.
const DRAG_THRESHOLD_PX = 4;
const KEYBOARD_SEEK_SECONDS = 1;

function useDeviceColumns(element: HTMLElement | null): number {
  const [columns, setColumns] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setColumns(Math.min(SPECTROGRAM_MAX_FRAMES, Math.round(width * window.devicePixelRatio)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return columns;
}

const serverPreviewNotices: Record<Exclude<ServerAudioPreviewState['status'], 'ready'>, string> = {
  none: text.audioAnalysisSkipped,
  pending: text.audioServerPreviewPending,
  failed: text.audioServerPreviewFailed,
};

function AudioMetaList({ summary }: { summary: AudioMediaSummary }) {
  return (
    <dl className="audio-meta">
      <dt>{text.audioSampleRate}</dt>
      <dd className="mono">
        {artifactsTextTemplates.audioSampleRateValue(summary.sampleRate)}
        {!summary.sampleRateFromFile && <small> {text.audioSampleRateDecoded}</small>}
      </dd>
      <dt>{text.audioDuration}</dt>
      <dd className="mono">{formatAudioTime(summary.durationSeconds)}</dd>
      <dt>{text.audioChannels}</dt>
      <dd className="mono">{summary.channelCount}</dd>
    </dl>
  );
}

export function AudioArtifactViewer({
  artifact,
  onPlay,
  onAudioElement,
}: {
  artifact: Artifact;
  /** Called when this player starts, so a comparison can pause the others. */
  onPlay?: () => void;
  onAudioElement?: (element: HTMLAudioElement | null) => void;
}) {
  const url = trackingApi.artifactUrl(artifact.projectId, artifact.id);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
  const [loop, setLoop] = useState<LoopRange | null>(null);
  const [visibleRange, setVisibleRange] = useState<TimeRange | null>(null);
  const [channel, setChannel] = useState<AudioChannelSelection>('mix');
  const [scale, setScale] = useState<SpectrogramScale>('linear');
  const [mediaError, setMediaError] = useState(false);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [drag, setDrag] = useState<{ startX: number; startSeconds: number; currentSeconds: number } | null>(null);
  const playback = useAudioPlayback(audio, loop);
  const columns = useDeviceColumns(timeline);
  const analysis = useAudioAnalysis({
    url,
    sizeBytes: artifact.size,
    view: columns > 0 ? { channel, range: visibleRange, columns, scale } : null,
  });
  const headerMediaInfo = useArtifactMediaInfo(artifact);
  // Files over the browser's analysis limit use the waveform the preview worker generated.
  const serverPreview = useServerAudioPreview(artifact, analysis.status === 'too_large');

  useEffect(() => {
    onAudioElement?.(audio);
    return () => onAudioElement?.(null);
  }, [onAudioElement, audio]);

  const retry = () => {
    setMediaError(false);
    setMediaRevision((value) => value + 1);
    analysis.retry();
  };
  const audioElement = (
    <audio
      key={mediaRevision}
      ref={setAudio}
      controls
      preload="metadata"
      src={url}
      onPlay={onPlay}
      onError={() => setMediaError(true)}
      aria-label={artifact.path}
    />
  );

  if (analysis.status === 'too_large') {
    const headerSummary = summarizeAudioMedia(null, headerMediaInfo);
    return (
      <div className="audio-viewer">
        {serverPreview.status === 'ready' ? (
          <AudioPreviewOverview
            waveform={serverPreview.waveform}
            spectrogramUrl={serverPreview.spectrogramUrl}
            currentTime={playback.currentTime}
            onSeek={playback.seek}
          />
        ) : (
          <p className="notice">{serverPreviewNotices[serverPreview.status]}</p>
        )}
        {headerSummary && <AudioMetaList summary={headerSummary} />}
        {mediaError ? <ErrorNotice message={text.audioPlaybackError} retry={retry} /> : audioElement}
      </div>
    );
  }

  const info = analysis.status === 'ready' ? analysis.info : null;
  const duration = info?.durationSeconds ?? 0;
  // Until decoding finishes, the stored header values fill the listed properties and total time.
  const summary = summarizeAudioMedia(info, headerMediaInfo);
  const range = visibleRange ?? { startSeconds: 0, endSeconds: duration };
  const timeAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return timeAtFraction((event.clientX - box.left) / box.width, range);
  };
  const zoom = (factor: number) =>
    info && setVisibleRange(zoomTimeRange(range, factor, playback.currentTime, info.durationSeconds));
  const shownLoop = drag ? loopRangeBetween(drag.startSeconds, drag.currentSeconds) : loop;
  const percent = (seconds: number) => `${fractionOfTime(seconds, range) * 100}%`;

  return (
    <div className="audio-viewer">
      <div className="audio-viewer-toolbar">
        <button
          type="button"
          className="button small"
          onClick={playback.togglePlayback}
          disabled={mediaError}
          aria-label={playback.playing ? text.audioPause : text.audioPlay}
        >
          {playback.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span className="mono audio-time">
          {formatAudioTime(playback.currentTime)} / {formatAudioTime(summary?.durationSeconds ?? 0)}
        </span>
        <button type="button" className="button small" onClick={() => zoom(ZOOM_STEP)} disabled={!info} aria-label={text.audioZoomIn}>
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => zoom(1 / ZOOM_STEP)}
          disabled={!visibleRange}
          aria-label={text.audioZoomOut}
        >
          <ZoomOut size={14} />
        </button>
        <button type="button" className="button small" onClick={() => setVisibleRange(null)} disabled={!visibleRange}>
          {text.audioZoomReset}
        </button>
        <label className="audio-viewer-select">
          {text.audioChannel}
          <select
            value={String(channel)}
            onChange={(event) => setChannel(event.target.value === 'mix' ? 'mix' : Number(event.target.value))}
            disabled={!info || info.channelCount < 2}
          >
            <option value="mix">{text.audioChannelMix}</option>
            {Array.from({ length: info?.channelCount ?? 0 }, (_, index) => (
              <option key={index} value={index}>
                {artifactsTextTemplates.audioChannelNumber(index + 1)}
              </option>
            ))}
          </select>
        </label>
        <label className="audio-viewer-select">
          {text.audioSpectrogramScale}
          <select value={scale} onChange={(event) => setScale(event.target.value as SpectrogramScale)}>
            <option value="linear">{text.audioScaleLinear}</option>
            <option value="mel">{text.audioScaleMel}</option>
          </select>
        </label>
        {loop && (
          <span className="audio-loop-label">
            <Repeat size={14} aria-hidden="true" />
            <span className="mono">
              {formatAudioTime(loop.startSeconds)}–{formatAudioTime(loop.endSeconds)}
            </span>
            <button type="button" className="icon-button" onClick={() => setLoop(null)} aria-label={text.audioLoopClear}>
              <X size={14} />
            </button>
          </span>
        )}
      </div>
      <div
        ref={setTimeline}
        className="audio-timeline"
        role="slider"
        tabIndex={0}
        aria-label={text.audioTimeline}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 100) / 100}
        aria-valuenow={Math.round(playback.currentTime * 100) / 100}
        aria-valuetext={formatAudioTime(playback.currentTime)}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowRight' ? KEYBOARD_SEEK_SECONDS : event.key === 'ArrowLeft' ? -KEYBOARD_SEEK_SECONDS : 0;
          if (!step) return;
          event.preventDefault();
          playback.seek(Math.min(duration, playback.currentTime + step));
        }}
        onPointerDown={(event) => {
          if (!info) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const seconds = timeAtPointer(event);
          setDrag({ startX: event.clientX, startSeconds: seconds, currentSeconds: seconds });
        }}
        onPointerMove={(event) => {
          if (drag && Math.abs(event.clientX - drag.startX) >= DRAG_THRESHOLD_PX)
            setDrag({ ...drag, currentSeconds: timeAtPointer(event) });
        }}
        onPointerUp={(event) => {
          if (!drag) return;
          setDrag(null);
          if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) {
            playback.seek(drag.startSeconds);
            return;
          }
          const selected = loopRangeBetween(drag.startSeconds, timeAtPointer(event));
          setLoop(selected);
          playback.seek(selected.startSeconds);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {analysis.status === 'ready' && analysis.analysis ? (
          <>
            <AudioWaveform peaks={analysis.analysis.peaks} height={WAVEFORM_HEIGHT} />
            <AudioSpectrogram spectrogram={analysis.analysis.spectrogram} height={SPECTROGRAM_HEIGHT} />
            <span className="audio-frequency-label mono" style={{ top: WAVEFORM_HEIGHT + FREQUENCY_LABEL_OFFSET }}>
              {artifactsTextTemplates.audioMaxFrequency(analysis.analysis.spectrogram.maxFrequency)}
            </span>
          </>
        ) : analysis.status === 'error' ? null : (
          <div className="audio-timeline-placeholder" style={{ height: WAVEFORM_HEIGHT + SPECTROGRAM_HEIGHT }}>
            <Loading />
          </div>
        )}
        {shownLoop && (
          <div
            className="audio-loop-region"
            style={{ left: percent(shownLoop.startSeconds), width: `${(fractionOfTime(shownLoop.endSeconds, range) - fractionOfTime(shownLoop.startSeconds, range)) * 100}%` }}
          />
        )}
        {info && <div className="audio-playhead" style={{ left: percent(playback.currentTime) }} />}
      </div>
      {analysis.status === 'error' && (
        <ErrorNotice
          message={analysis.reason === 'decode' ? text.audioDecodeError : analysis.reason === 'analysis' ? text.audioAnalysisError : text.audioFetchError}
          retry={retry}
        />
      )}
      {info && visibleRange && (
        <input
          type="range"
          className="audio-pan"
          aria-label={text.audioPan}
          min={0}
          max={info.durationSeconds - (visibleRange.endSeconds - visibleRange.startSeconds)}
          step="any"
          value={visibleRange.startSeconds}
          onChange={(event) => {
            const start = Number(event.target.value);
            setVisibleRange(
              clampTimeRange(
                { startSeconds: start, endSeconds: start + visibleRange.endSeconds - visibleRange.startSeconds },
                info.durationSeconds,
              ),
            );
          }}
        />
      )}
      {summary && <AudioMetaList summary={summary} />}
      {mediaError ? <ErrorNotice message={text.audioPlaybackError} retry={retry} /> : audioElement}
      <p className="muted audio-hint">{text.audioTimelineHint}</p>
    </div>
  );
}

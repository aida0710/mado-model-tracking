import { useEffect, useState } from 'react';
import type { MediaTableColumn } from '@mmt/contracts';
import { AudioLines, Maximize2, Pause, Play, X } from 'lucide-react';
import { trackingApi } from '../../api/tracking';
import type { ExclusiveAudio } from '../../hooks/useExclusiveAudio';
import { describeTableCell, type ResolvedMediaCell } from '../../lib/mediaTableCells';
import { tableCellArtifact } from '../../lib/mediaPreviewArtifact';
import { AudioArtifactViewer } from '../preview/AudioArtifactViewer';
import { ImagePreview } from '../preview/ImagePreview';
import { VideoPreview } from '../preview/VideoPreview';
import { mediaCellErrorLabels } from '../../i18n/media';
import { text } from '../../i18n/catalog';

/** The table's one-at-a-time playback and this cell's player id in it. */
export interface CellPlayback {
  exclusiveAudio: ExclusiveAudio;
  cellId: string;
}

function AudioCell({ projectId, media, playback }: { projectId: string; media: ResolvedMediaCell; playback: CellPlayback }) {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { exclusiveAudio, cellId } = playback;
  const viewerId = `${cellId}:viewer`;
  useEffect(() => {
    const register = exclusiveAudio.register(cellId);
    register(audio);
    return () => register(null);
  }, [audio, exclusiveAudio, cellId]);
  return (
    <div className="media-cell-audio">
      {/* preload="none": a page of 50 rows must not download 50 files before anyone presses play. */}
      <audio
        ref={setAudio}
        preload="none"
        src={trackingApi.artifactUrl(projectId, media.artifactId)}
        aria-label={media.path}
        onPlay={() => {
          setPlaying(true);
          exclusiveAudio.played(cellId);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      {/* The open viewer has its own play button; one control per cell keeps it clear which one plays. */}
      {!expanded && (
        <button
          type="button"
          className="button small"
          aria-label={playing ? text.mediaCellPause : text.mediaCellPlay}
          onClick={() => (audio?.paused ? void audio.play().catch(() => undefined) : audio?.pause())}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
      )}
      <button
        type="button"
        className="button small"
        aria-expanded={expanded}
        onClick={() => {
          audio?.pause();
          setExpanded(!expanded);
        }}
      >
        <AudioLines size={14} />
        {text.mediaCellWaveform}
      </button>
      {expanded && (
        <div className="media-cell-detail">
          <AudioArtifactViewer
            artifact={tableCellArtifact(projectId, media)}
            onPlay={() => exclusiveAudio.played(viewerId)}
            onAudioElement={exclusiveAudio.register(viewerId)}
          />
        </div>
      )}
    </div>
  );
}

function ImageCell({ projectId, media }: { projectId: string; media: ResolvedMediaCell }) {
  const [expanded, setExpanded] = useState(false);
  const thumbnailId = media.thumbnailArtifactId ?? media.artifactId;
  return (
    <div className="media-cell-image">
      <button
        type="button"
        className="media-thumbnail-button"
        aria-expanded={expanded}
        aria-label={`${text.mediaCellOpen}: ${media.path}`}
        onClick={() => setExpanded(!expanded)}
      >
        <img src={trackingApi.artifactUrl(projectId, thumbnailId)} alt={media.path} loading="lazy" />
      </button>
      {expanded && (
        <div className="media-cell-detail">
          <ImagePreview artifact={tableCellArtifact(projectId, media)} />
        </div>
      )}
    </div>
  );
}

function VideoCell({ projectId, media }: { projectId: string; media: ResolvedMediaCell }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="media-cell-video">
      <button type="button" className="button small" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? <X size={14} /> : <Maximize2 size={14} />}
        {expanded ? text.mediaCellClose : text.mediaCellOpen}
      </button>
      {expanded && <VideoPreview artifact={tableCellArtifact(projectId, media)} />}
    </div>
  );
}

/** One cell of a media table; media cells load nothing until they are played or opened, except image thumbnails. */
export function MediaCell({
  projectId,
  column,
  value,
  playback,
}: {
  projectId: string;
  column: MediaTableColumn;
  value: unknown;
  playback: CellPlayback;
}) {
  const cell = describeTableCell(column, value);
  switch (cell.kind) {
    case 'empty':
      return <span className="muted">—</span>;
    case 'text':
      return <span className="media-cell-text">{cell.text}</span>;
    case 'number':
      return <span className="mono">{cell.text}</span>;
    case 'json':
      return <code className="media-cell-json">{cell.text}</code>;
    case 'error':
      return (
        <span className="sample-error media-cell-error" title={cell.path}>
          {mediaCellErrorLabels[cell.reason]}
        </span>
      );
    case 'media':
      if (cell.media.type === 'audio') return <AudioCell projectId={projectId} media={cell.media} playback={playback} />;
      if (cell.media.type === 'image') return <ImageCell projectId={projectId} media={cell.media} />;
      return <VideoCell projectId={projectId} media={cell.media} />;
  }
}

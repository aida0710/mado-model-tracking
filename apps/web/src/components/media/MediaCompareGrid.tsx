import { useCallback, useMemo, useRef, useState } from 'react';
import type { MediaCompareGrid as MediaCompareGridData, RunMedia } from '@mmt/contracts';
import { AudioLines, Film, Table2 } from 'lucide-react';
import { trackingApi } from '../../api/tracking';
import { formatAudioTime } from '../../lib/audioTimeline';
import {
  compareTableOf,
  gridPositionAfterKey,
  handoffPosition,
  playbackHandoffFrom,
  type GridPosition,
  type CompareTable,
  type PlaybackHandoff,
} from '../../lib/mediaSteps';
import { runMediaArtifact } from '../../lib/mediaPreviewArtifact';
import { AudioArtifactViewer } from '../preview/AudioArtifactViewer';
import { ImagePreview } from '../preview/ImagePreview';
import { VideoPreview } from '../preview/VideoPreview';
import { MediaTableView } from './MediaTableView';
import { mediaKindLabels } from '../../i18n/media';
import { text, textTemplates } from '../../i18n/catalog';

export interface MediaCompareGridProps {
  projectId: string;
  grid: MediaCompareGridData;
  /** Display name per Run id; the id is shown for Runs missing here. */
  runLabels: Record<string, string>;
}

function firstFilledCell(table: CompareTable): GridPosition {
  for (let row = 0; row < table.cells.length; row += 1) {
    const column = table.cells[row]!.findIndex((cell) => cell !== null);
    if (column >= 0) return { row, column };
  }
  return { row: 0, column: 0 };
}

function CellSummary({ projectId, media }: { projectId: string; media: RunMedia | null }) {
  if (!media) return <span className="muted">{text.mediaCompareMissing}</span>;
  switch (media.kind) {
    case 'image':
      return (
        <img
          src={trackingApi.artifactUrl(projectId, media.thumbnailArtifactId ?? media.artifactId)}
          alt=""
          loading="lazy"
        />
      );
    case 'audio':
      return (
        <span className="media-compare-audio">
          <AudioLines size={14} aria-hidden="true" />
          {media.mediaInfo && <span className="mono">{formatAudioTime(media.mediaInfo.durationSeconds)}</span>}
        </span>
      );
    case 'video':
      return <Film size={14} aria-hidden="true" />;
    case 'table':
      return <Table2 size={14} aria-hidden="true" />;
  }
}

/**
 * Starts the next audio player where the previous one was: same position, and playing if it was.
 * The position is applied once the new file's duration is known, so a shorter file starts over.
 */
function useAudioHandoff() {
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const pendingHandoff = useRef<PlaybackHandoff | null>(null);
  const attachAudio = useCallback((element: HTMLAudioElement | null) => {
    currentAudio.current = element;
    const handoff = pendingHandoff.current;
    if (!element || !handoff) return;
    pendingHandoff.current = null;
    const apply = () => {
      element.currentTime = handoffPosition(handoff.seconds, Number.isFinite(element.duration) ? element.duration : null);
      if (handoff.playing) void element.play().catch(() => undefined);
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else element.addEventListener('loadedmetadata', apply, { once: true });
  }, []);
  /** Call before showing another cell; `toAudio` false drops the handoff (nothing to hand it to). */
  const leaveCurrent = useCallback((toAudio: boolean) => {
    pendingHandoff.current = toAudio ? playbackHandoffFrom(currentAudio.current) : null;
    currentAudio.current?.pause();
  }, []);
  return { attachAudio, leaveCurrent };
}

/**
 * Runs as rows and steps as columns, from a /media/compare response. Empty cells say so; they are
 * never filled from a nearby step. One cell is shown below the grid at a time, so only one audio
 * plays, and moving to another audio cell continues from the same position (A/B listening).
 * It only displays the data it is given, so a report can show a grid fixed when it was made.
 */
export function MediaCompareGrid({ projectId, grid, runLabels }: MediaCompareGridProps) {
  const table = useMemo(() => compareTableOf(grid), [grid]);
  const [selected, setSelected] = useState<GridPosition>(() => firstFilledCell(table));
  const cellButtons = useRef(new Map<string, HTMLButtonElement>());
  const { attachAudio, leaveCurrent } = useAudioHandoff();
  const size = { rows: table.runIds.length, columns: table.steps.length };
  // A cell normally holds one item; the first is shown when a Run logged several at that step.
  const cellAt = (position: GridPosition) => table.cells[position.row]?.[position.column]?.[0] ?? null;
  const cellCountAt = (position: GridPosition) => table.cells[position.row]?.[position.column]?.length ?? 0;
  const runLabel = (runId: string) => runLabels[runId] ?? runId;
  const positionKey = (position: GridPosition) => `${position.row}:${position.column}`;

  const select = (next: GridPosition) => {
    if (next.row === selected.row && next.column === selected.column) return;
    leaveCurrent(cellAt(next)?.kind === 'audio');
    setSelected(next);
    cellButtons.current.get(positionKey(next))?.focus();
  };
  const selectedMedia = cellAt(selected);
  const selectedRunId = table.runIds[selected.row];
  const selectedStep = table.steps[selected.column];
  const selectedCount = cellCountAt(selected);

  return (
    <div className="media-compare-grid">
      <p className="muted media-hint">{text.mediaCompareHint}</p>
      <div className="table-scroll">
        <table
          role="grid"
          aria-label={text.mediaCompareGrid}
          onKeyDown={(event) => {
            const next = gridPositionAfterKey(size, selected, event.key);
            if (!next) return;
            event.preventDefault();
            select(next);
          }}
        >
          <thead>
            <tr>
              <th scope="col">{text.mediaRun}</th>
              {table.steps.map((step) => (
                <th key={step} scope="col" className="mono">
                  {text.mediaStep} {step}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.runIds.map((runId, row) => (
              <tr key={runId}>
                <th scope="row">{runLabel(runId)}</th>
                {table.steps.map((step, column) => {
                  const media = cellAt({ row, column });
                  const isSelected = row === selected.row && column === selected.column;
                  const state = media ? mediaKindLabels[media.kind] : text.mediaCompareMissing;
                  return (
                    <td key={step} role="gridcell" aria-selected={isSelected} className={isSelected ? 'selected' : ''}>
                      <button
                        type="button"
                        ref={(element) => {
                          const key = positionKey({ row, column });
                          if (element) cellButtons.current.set(key, element);
                          else cellButtons.current.delete(key);
                        }}
                        className={`media-compare-cell ${media ? '' : 'missing'}`}
                        tabIndex={isSelected ? 0 : -1}
                        aria-label={textTemplates.mediaCompareCell(runLabel(runId), step, state)}
                        onClick={() => select({ row, column })}
                      >
                        <CellSummary projectId={projectId} media={media} />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="media-compare-detail" aria-live="polite">
        {selectedRunId !== undefined && selectedStep !== undefined && (
          <h4>
            {runLabel(selectedRunId)} · {text.mediaStep} {selectedStep}
          </h4>
        )}
        {!selectedMedia ? (
          <p className="muted">{selectedRunId === undefined ? text.mediaCompareNoSelection : text.mediaCompareMissing}</p>
        ) : (
          <>
            {selectedCount > 1 && <p className="muted">{textTemplates.mediaCompareFirstOfMany(selectedCount)}</p>}
            {selectedMedia.caption && <p className="media-caption">{selectedMedia.caption}</p>}
            {selectedMedia.kind === 'audio' && (
              <AudioArtifactViewer
                key={selectedMedia.id}
                artifact={runMediaArtifact(projectId, selectedMedia)}
                onAudioElement={attachAudio}
              />
            )}
            {selectedMedia.kind === 'image' && (
              <ImagePreview key={selectedMedia.id} artifact={runMediaArtifact(projectId, selectedMedia)} />
            )}
            {selectedMedia.kind === 'video' && (
              <VideoPreview key={selectedMedia.id} artifact={runMediaArtifact(projectId, selectedMedia)} />
            )}
            {selectedMedia.kind === 'table' && (
              <MediaTableView
                key={selectedMedia.id}
                projectId={projectId}
                runId={selectedMedia.runId}
                mediaId={selectedMedia.id}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

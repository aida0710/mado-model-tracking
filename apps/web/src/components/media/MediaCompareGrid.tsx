import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { narrowerThan } from '../../lib/breakpoints';
import { useMediaQuery } from '../../lib/useMediaQuery';
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
export function MediaCompareGrid(props: MediaCompareGridProps) {
  const isNarrow = useMediaQuery(narrowerThan('md'));
  return <MediaCompareGridView {...props} isNarrow={isNarrow} />;
}

/**
 * The grid for a known width. A narrow screen stacks the Runs: each Run's steps in a block of its
 * own, with the chosen cell's player right under the Run it belongs to.
 */
export function MediaCompareGridView({
  projectId,
  grid,
  runLabels,
  isNarrow,
}: MediaCompareGridProps & { isNarrow: boolean }) {
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
  const moveWithKeyboard = (event: KeyboardEvent) => {
    const next = gridPositionAfterKey(size, selected, event.key);
    if (!next) return;
    event.preventDefault();
    select(next);
  };
  const isSelectedCell = (position: GridPosition) => position.row === selected.row && position.column === selected.column;
  const cellButton = (position: GridPosition) => {
    const runId = table.runIds[position.row]!;
    const step = table.steps[position.column]!;
    const media = cellAt(position);
    const state = media ? mediaKindLabels[media.kind] : text.mediaCompareMissing;
    return (
      <button
        type="button"
        ref={(element) => {
          const key = positionKey(position);
          if (element) cellButtons.current.set(key, element);
          else cellButtons.current.delete(key);
        }}
        className={`media-compare-cell ${media ? '' : 'missing'}`}
        tabIndex={isSelectedCell(position) ? 0 : -1}
        aria-label={textTemplates.mediaCompareCell(runLabel(runId), step, state)}
        aria-pressed={isNarrow ? isSelectedCell(position) : undefined}
        onClick={() => select(position)}
      >
        <CellSummary projectId={projectId} media={media} />
      </button>
    );
  };
  const detail = (
    <SelectedCellDetail
      projectId={projectId}
      runLabel={table.runIds[selected.row] === undefined ? undefined : runLabel(table.runIds[selected.row]!)}
      step={table.steps[selected.column]}
      media={cellAt(selected)}
      count={cellCountAt(selected)}
      attachAudio={attachAudio}
    />
  );

  if (isNarrow)
    return (
      <div className="media-compare-grid stacked">
        <p className="muted media-hint">{text.mediaCompareHint}</p>
        <div className="media-compare-runs" aria-label={text.mediaCompareGrid} onKeyDown={moveWithKeyboard}>
          {table.runIds.map((runId, row) => (
            <RunStack key={runId} label={runLabel(runId)}>
              {table.steps.map((step, column) => (
                <div key={step} className={`media-compare-run-step ${isSelectedCell({ row, column }) ? 'selected' : ''}`}>
                  <span className="mono">
                    {text.mediaStep} {step}
                  </span>
                  {cellButton({ row, column })}
                </div>
              ))}
              {row === selected.row && detail}
            </RunStack>
          ))}
          {table.runIds.length === 0 && detail}
        </div>
      </div>
    );

  return (
    <div className="media-compare-grid">
      <p className="muted media-hint">{text.mediaCompareHint}</p>
      <div className="table-scroll">
        <table role="grid" aria-label={text.mediaCompareGrid} onKeyDown={moveWithKeyboard}>
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
                {table.steps.map((step, column) => (
                  <td
                    key={step}
                    role="gridcell"
                    aria-selected={isSelectedCell({ row, column })}
                    className={isSelectedCell({ row, column }) ? 'selected' : ''}
                  >
                    {cellButton({ row, column })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail}
    </div>
  );
}

/** One Run's steps on a narrow screen, laid out as a wrapping row of cells under the Run's name. */
function RunStack({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="media-compare-run" aria-label={label}>
      <h5>{label}</h5>
      <div className="media-compare-run-steps">{children}</div>
    </section>
  );
}

function SelectedCellDetail({
  projectId,
  runLabel,
  step,
  media,
  count,
  attachAudio,
}: {
  projectId: string;
  runLabel: string | undefined;
  step: number | undefined;
  media: RunMedia | null;
  count: number;
  attachAudio: (element: HTMLAudioElement | null) => void;
}) {
  return (
    <section className="media-compare-detail" aria-live="polite">
      {runLabel !== undefined && step !== undefined && (
        <h4>
          {runLabel} · {text.mediaStep} {step}
        </h4>
      )}
      {!media ? (
        <p className="muted">{runLabel === undefined ? text.mediaCompareNoSelection : text.mediaCompareMissing}</p>
      ) : (
        <>
          {count > 1 && <p className="muted">{textTemplates.mediaCompareFirstOfMany(count)}</p>}
          {media.caption && <p className="media-caption">{media.caption}</p>}
          {media.kind === 'audio' && (
            <AudioArtifactViewer key={media.id} artifact={runMediaArtifact(projectId, media)} onAudioElement={attachAudio} />
          )}
          {media.kind === 'image' && <ImagePreview key={media.id} artifact={runMediaArtifact(projectId, media)} />}
          {media.kind === 'video' && <VideoPreview key={media.id} artifact={runMediaArtifact(projectId, media)} />}
          {media.kind === 'table' && (
            <MediaTableView key={media.id} projectId={projectId} runId={media.runId} mediaId={media.id} />
          )}
        </>
      )}
    </section>
  );
}

import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RUN_NOTE_TAG, type Run, type SavedViewColumn } from '@mmt/contracts';
import { RunStatusBadge } from './RunStatusBadge';
import { runCreatorName } from '../../lib/runCreator';
import { CompactValue } from '../CompactValue';
import { Empty } from '../Feedback';
import { MarkdownView } from '../markdown/MarkdownView';
import { getRunParameters } from '../../lib/runParameters';
import { formatDate, formatDuration } from '../../lib/format';
import {
  clampColumnWidth,
  descriptionSummary,
  moveColumn,
  resizeColumn,
  RUN_DESCRIPTION_COLUMN,
  shiftColumn,
} from '../../lib/runColumns';
import { text } from '../../i18n/catalog';

// One arrow key press widens or narrows a column by this much, like a coarse mouse drag.
const KEYBOARD_RESIZE_STEP = 16;

interface RunColumn {
  label: ReactNode;
  render: (run: Run) => ReactNode;
  className?: string;
}

const groupLabel = (group: string, name: string) => (
  <>
    <small>{group}</small>
    <span className="run-column-name" title={name}>
      {name}
    </span>
  </>
);

/** How a movable column key is drawn; unknown keys from a newer client are skipped. */
function runColumn(key: string): RunColumn | null {
  const [group, ...rest] = key.split('.');
  const name = rest.join('.');
  if (group === 'metrics' && name)
    return {
      label: groupLabel(text.metrics, name),
      render: (run) => <CompactValue value={run.latestMetrics[name]} />,
      className: 'mono numeric',
    };
  if (group === 'params' && name)
    return {
      label: groupLabel(text.parameters, name),
      render: (run) => <CompactValue value={getRunParameters(run)[name]} />,
      className: 'mono',
    };
  // The description has its own column; as a tag it would fill the row with raw Markdown.
  if (group === 'tags' && name && name !== RUN_NOTE_TAG)
    return {
      label: groupLabel(text.tags, name),
      render: (run) => <CompactValue value={run.tags[name]} />,
      className: 'mono',
    };
  switch (key) {
    case 'status':
      return { label: text.status, render: (run) => <RunStatusBadge run={run} /> };
    case 'created':
      return { label: text.created, render: (run) => formatDate(run.createdAt), className: 'nowrap' };
    case 'duration':
      return {
        label: text.duration,
        render: (run) => formatDuration(run.startedAt, run.endedAt),
        className: 'mono nowrap',
      };
    case 'user':
      return {
        label: text.user,
        render: (run) => (
          <span className="run-user" title={run.createdBy}>
            {runCreatorName(run)}
          </span>
        ),
      };
    case 'kind':
      return { label: text.kind, render: (run) => text[run.kind], className: 'nowrap' };
    case RUN_DESCRIPTION_COLUMN:
      return {
        label: text.runDescriptionColumn,
        render: (run) => <RunDescriptionCell description={run.tags[RUN_NOTE_TAG] ?? ''} />,
      };
    default:
      return null;
  }
}

/**
 * The first line of the description; the whole Markdown opens while hovered or focused. The
 * popover is fixed to the viewport because the table's scroll area would clip it.
 */
function RunDescriptionCell({ description }: { description: string }) {
  const [popoverPosition, setPopoverPosition] = useState<CSSProperties | null>(null);
  if (!description.trim()) return null;
  const open = (cell: HTMLElement) => {
    const rect = cell.getBoundingClientRect();
    setPopoverPosition({ top: rect.bottom + 4, left: rect.left });
  };
  return (
    <span
      className="run-description-cell"
      tabIndex={0}
      onMouseEnter={(event) => open(event.currentTarget)}
      onMouseLeave={() => setPopoverPosition(null)}
      onFocus={(event) => open(event.currentTarget)}
      onBlur={() => setPopoverPosition(null)}
    >
      <span className="run-description-summary">{descriptionSummary(description)}</span>
      {popoverPosition && (
        <span className="run-description-popover" role="tooltip" style={popoverPosition}>
          <MarkdownView source={description} />
        </span>
      )}
    </span>
  );
}

const widthStyle = (width: number | undefined): CSSProperties | undefined =>
  width === undefined ? undefined : { width, minWidth: width, maxWidth: width };

export function RunTable({
  projectId,
  runs,
  columns,
  onColumnsChange,
  selectedIds,
  onSelectedIdsChange,
}: {
  projectId: string;
  runs: Run[];
  /** Shown after the selection and name columns, in this order and width. */
  columns: SavedViewColumn[];
  onColumnsChange: (columns: SavedViewColumn[]) => void;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  // While the pointer drags a border the width lives here, so the list commits one change.
  const [resizing, setResizing] = useState<{ key: string; startX: number; startWidth: number; width: number } | null>(null);
  if (!runs.length) return <Empty>{text.noResults}</Empty>;

  const allShownSelected = runs.every((run) => selectedIds.includes(run.id));
  function toggleRun(id: string) {
    onSelectedIdsChange(
      selectedIds.includes(id)
        ? selectedIds.filter((selected) => selected !== id)
        : [...selectedIds, id],
    );
  }
  function toggleShownRuns(selected: boolean) {
    onSelectedIdsChange(
      selected
        ? Array.from(new Set([...selectedIds, ...runs.map((run) => run.id)]))
        : selectedIds.filter((id) => !runs.some((run) => run.id === id)),
    );
  }
  const shownColumns = columns.flatMap((column) => {
    const definition = runColumn(column.key);
    const width = resizing?.key === column.key ? resizing.width : column.width;
    return definition ? [{ ...definition, key: column.key, width }] : [];
  });

  function startResize(event: PointerEvent<HTMLSpanElement>, key: string) {
    const header = event.currentTarget.closest('th');
    if (!header) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = header.getBoundingClientRect().width;
    setResizing({ key, startX: event.clientX, startWidth, width: clampColumnWidth(startWidth) });
  }
  function moveResize(event: PointerEvent<HTMLSpanElement>) {
    if (!resizing) return;
    const width = clampColumnWidth(resizing.startWidth + event.clientX - resizing.startX);
    setResizing({ ...resizing, width });
  }
  function finishResize() {
    if (!resizing) return;
    onColumnsChange(resizeColumn(columns, resizing.key, resizing.width));
    setResizing(null);
  }
  function resizeWithKeyboard(event: KeyboardEvent<HTMLSpanElement>, key: string) {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const header = event.currentTarget.closest('th');
    if (!direction || !header) return;
    event.preventDefault();
    const current = columns.find((column) => column.key === key)?.width;
    const width = (current ?? header.getBoundingClientRect().width) + direction * KEYBOARD_RESIZE_STEP;
    onColumnsChange(resizeColumn(columns, key, width));
  }
  function moveWithKeyboard(event: KeyboardEvent<HTMLSpanElement>, key: string) {
    if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    onColumnsChange(shiftColumn(columns, key, event.key === 'ArrowLeft' ? -1 : 1));
  }

  return (
    <div className="table-scroll">
      <table className="run-table">
        <thead>
          <tr>
            <th scope="col">
              <input
                type="checkbox"
                aria-label={text.selectAll}
                checked={allShownSelected}
                onChange={(event) => toggleShownRuns(event.target.checked)}
              />
            </th>
            <th scope="col">{text.runName}</th>
            {shownColumns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-column={column.key}
                className={`run-column-header ${column.className ?? ''} ${draggedKey === column.key ? 'dragging' : ''}`.trim()}
                style={widthStyle(column.width)}
                draggable={!resizing}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', column.key);
                  setDraggedKey(column.key);
                }}
                onDragOver={(event) => {
                  if (draggedKey) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedKey) onColumnsChange(moveColumn(columns, draggedKey, column.key));
                  setDraggedKey(null);
                }}
                onDragEnd={() => setDraggedKey(null)}
              >
                <span
                  className="run-column-label"
                  tabIndex={0}
                  title={text.runColumnMove}
                  onKeyDown={(event) => moveWithKeyboard(event, column.key)}
                >
                  {column.label}
                </span>
                <span
                  className="run-column-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={text.runColumnResize}
                  {...(column.width === undefined ? {} : { 'aria-valuenow': column.width })}
                  tabIndex={0}
                  onPointerDown={(event) => startResize(event, column.key)}
                  onPointerMove={moveResize}
                  onPointerUp={finishResize}
                  onPointerCancel={() => setResizing(null)}
                  onKeyDown={(event) => resizeWithKeyboard(event, column.key)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className={selectedIds.includes(run.id) ? 'selected' : ''}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${text.selectRun}: ${run.name}`}
                  checked={selectedIds.includes(run.id)}
                  onChange={() => toggleRun(run.id)}
                />
              </td>
              <td>
                <Link className="run-name" title={run.name} to={`/projects/${projectId}/runs/${run.id}`}>
                  {run.name}
                </Link>
              </td>
              {shownColumns.map((column) => (
                <td
                  key={column.key}
                  className={`${column.className ?? ''} ${column.width === undefined ? '' : 'sized'}`.trim()}
                  style={widthStyle(column.width)}
                >
                  {column.render(run)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

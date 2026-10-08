import { useId, useMemo, useRef, useState } from 'react';
import { FileText, LayoutGrid } from 'lucide-react';
import {
  REPORT_MESSAGE_MAX_LENGTH,
  REPORT_TITLE_MAX_LENGTH,
  type ReportBlock,
  type ReportBlockSnapshot,
  type ReportDocument,
  type ReportEmbedBlock,
} from '@mmt/contracts';
import { EmbedPicker } from './EmbedPicker';
import { ReportBlockEditor } from './ReportBlockEditor';
import { ErrorNotice, Empty } from '../Feedback';
import { UnsavedChangesDialog } from '../UnsavedChangesDialog';
import { useReportSave } from '../../hooks/useReport';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import {
  createBlock,
  insertBlock,
  moveBlock,
  refreshableSnapshotIds,
  removeBlock,
  replaceBlock,
  reportBlockProblem,
  snapshotsByBlockId,
} from '../../lib/reportBlocks';
import { text } from '../../i18n/catalog';

const newBlockId = () => crypto.randomUUID();

/**
 * Edits a report on top of one revision and saves the result as the next revision. When someone
 * else saved in between, the save is refused and the editor offers to load their revision.
 */
export function ReportEditor({
  projectId,
  document,
  snapshots,
  onSaved,
  onCancel,
  onReloadLatest,
}: {
  projectId: string;
  document: ReportDocument;
  /** Snapshots of the revision being edited. */
  snapshots: readonly ReportBlockSnapshot[];
  onSaved: (document: ReportDocument) => void;
  onCancel: () => void;
  /** Discards the edit and reads the current revision. */
  onReloadLatest: () => void;
}) {
  const id = useId();
  const base = document.revision;
  const [title, setTitle] = useState(base.title);
  const [blocks, setBlocks] = useState<ReportBlock[]>(base.blocks);
  const [message, setMessage] = useState('');
  const [refreshIds, setRefreshIds] = useState<ReadonlySet<string>>(new Set());
  const [newEmbed, setNewEmbed] = useState<ReportEmbedBlock | null>(null);
  const saving = useReportSave(projectId, document.report.id);
  const initial = useRef(JSON.stringify([base.title, base.blocks]));
  const isDirty = JSON.stringify([title, blocks]) !== initial.current || message !== '' || refreshIds.size > 0;
  const unsaved = useUnsavedChanges(isDirty, saving.pending, { onNavigationDiscard: onCancel });

  const savedBlocks = useMemo(() => new Map(base.blocks.map((block) => [block.id, JSON.stringify(block)])), [base.blocks]);
  const savedSnapshots = useMemo(() => snapshotsByBlockId(snapshots), [snapshots]);
  const savedSnapshotFor = (block: ReportBlock) =>
    savedBlocks.get(block.id) === JSON.stringify(block) ? savedSnapshots.get(block.id) : undefined;

  const trimmedTitle = title.trim();
  const hasProblem = !trimmedTitle || blocks.some((block) => reportBlockProblem(block) !== null);

  async function save() {
    if (hasProblem) return;
    const outcome = await saving.save({
      baseRevision: base.revision,
      title: trimmedTitle,
      blocks,
      ...(message.trim() ? { message: message.trim() } : {}),
      refreshSnapshotBlockIds: refreshableSnapshotIds(blocks, refreshIds),
    });
    if (outcome.kind === 'saved') onSaved(outcome.document);
  }

  function setRefreshRequested(blockId: string, isRequested: boolean) {
    const next = new Set(refreshIds);
    if (isRequested) next.add(blockId);
    else next.delete(blockId);
    setRefreshIds(next);
  }

  return (
    // Not a form: the chart editor opened from an embed has its own form, and nested forms submit
    // the page natively.
    <div className="report-editor">
      <div className="field">
        <label htmlFor={`${id}-title`}>{text.reportTitle}</label>
        <input
          id={`${id}-title`}
          value={title}
          maxLength={REPORT_TITLE_MAX_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
        />
        {!trimmedTitle && <small className="report-block-problem">{text.reportTitleRequired}</small>}
      </div>
      <div className="report-editor-blocks">
        {blocks.length === 0 && <Empty>{text.reportEmpty}</Empty>}
        {blocks.map((block, index) => (
          <ReportBlockEditor
            key={block.id}
            projectId={projectId}
            block={block}
            isFirst={index === 0}
            isLast={index === blocks.length - 1}
            savedSnapshot={savedSnapshotFor(block)}
            isRefreshRequested={refreshIds.has(block.id)}
            onChange={(next) => setBlocks(replaceBlock(blocks, next))}
            onMove={(offset) => setBlocks(moveBlock(blocks, block.id, offset))}
            onRemove={() => setBlocks(removeBlock(blocks, block.id))}
            onRefreshRequestedChange={(isRequested) => setRefreshRequested(block.id, isRequested)}
          />
        ))}
      </div>
      <div className="report-add-block">
        <button type="button" className="button" onClick={() => setBlocks(insertBlock(blocks, createBlock('markdown', newBlockId())))}>
          <FileText size={15} />
          {text.reportAddMarkdown}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setNewEmbed(createBlock('chart', newBlockId()) as ReportEmbedBlock)}
        >
          <LayoutGrid size={15} />
          {text.reportAddEmbed}
        </button>
      </div>
      <div className="field">
        <label htmlFor={`${id}-message`}>{text.reportMessage}</label>
        <input
          id={`${id}-message`}
          value={message}
          maxLength={REPORT_MESSAGE_MAX_LENGTH}
          placeholder={text.reportMessagePlaceholder}
          onChange={(event) => setMessage(event.target.value)}
        />
      </div>
      {saving.hasConflict && (
        <div className="notice report-conflict" role="alert" data-testid="report-conflict">
          <p>{text.reportConflict}</p>
          <p className="muted">{text.reportConflictReloadHint}</p>
          <button type="button" className="button small" onClick={onReloadLatest}>
            {text.reportConflictReload}
          </button>
        </div>
      )}
      <ErrorNotice message={saving.error} />
      <footer className="report-editor-footer">
        <button type="button" className="button" disabled={saving.pending} onClick={() => unsaved.requestAction(onCancel)}>
          {text.reportCancelEdit}
        </button>
        <button type="button" className="button primary" disabled={saving.pending || hasProblem} onClick={() => void save()}>
          {saving.pending ? text.reportSaving : text.reportSave}
        </button>
      </footer>
      {newEmbed && (
        <EmbedPicker
          projectId={projectId}
          initial={newEmbed}
          isNew
          onClose={() => setNewEmbed(null)}
          onApply={(block) => {
            setNewEmbed(null);
            setBlocks(insertBlock(blocks, block));
          }}
        />
      )}
      {unsaved.confirmingDiscard && <UnsavedChangesDialog onDiscard={unsaved.discard} onKeepEditing={unsaved.keepEditing} />}
    </div>
  );
}

import { useState } from 'react';
import { ArrowDown, ArrowUp, Settings2, Trash2 } from 'lucide-react';
import { REPORT_MARKDOWN_MAX_LENGTH, type ReportBlock, type ReportBlockSnapshot } from '@mmt/contracts';
import { MarkdownEditor } from '../markdown/MarkdownEditor';
import { EmbedPicker } from './EmbedPicker';
import { ReportBlockView } from './ReportBlockView';
import { reportBlockProblem } from '../../lib/reportBlocks';
import { reportBlockProblemLabels, reportBlockTypeLabels } from '../../i18n/reports';
import { text } from '../../i18n/catalog';

/**
 * One block in the editor: its place in the report, Markdown text or the embed settings, and a
 * preview drawn as readers will see it.
 */
export function ReportBlockEditor({
  projectId,
  block,
  isFirst,
  isLast,
  savedSnapshot,
  isRefreshRequested,
  onChange,
  onMove,
  onRemove,
  onRefreshRequestedChange,
}: {
  projectId: string;
  block: ReportBlock;
  isFirst: boolean;
  isLast: boolean;
  /** The stored snapshot while the block is unchanged since the revision being edited. */
  savedSnapshot: ReportBlockSnapshot | undefined;
  isRefreshRequested: boolean;
  onChange: (block: ReportBlock) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
  onRefreshRequestedChange: (isRequested: boolean) => void;
}) {
  const [isPicking, setPicking] = useState(false);
  const problem = reportBlockProblem(block);
  // A refreshed snapshot is captured on save; until then the preview shows the current data.
  const previewSnapshot = isRefreshRequested ? undefined : savedSnapshot;
  return (
    <section className="report-block-editor" aria-label={reportBlockTypeLabels[block.type]}>
      <header className="report-block-toolbar">
        <strong>{reportBlockTypeLabels[block.type]}</strong>
        <div className="report-block-actions">
          {block.type !== 'markdown' && (
            <button type="button" className="button small" onClick={() => setPicking(true)}>
              <Settings2 size={14} />
              {text.reportBlockSettings}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={text.reportBlockMoveUp}
            title={text.reportBlockMoveUp}
            disabled={isFirst}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={text.reportBlockMoveDown}
            title={text.reportBlockMoveDown}
            disabled={isLast}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={text.reportBlockRemove}
            title={text.reportBlockRemove}
            onClick={onRemove}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>
      {block.type === 'markdown' ? (
        <MarkdownEditor
          label={text.reportMarkdownLabel}
          value={block.text}
          maxLength={REPORT_MARKDOWN_MAX_LENGTH}
          rows={6}
          onChange={(value) => onChange({ ...block, text: value })}
        />
      ) : (
        <>
          {problem ? (
            <p className="report-block-problem">{reportBlockProblemLabels[problem]}</p>
          ) : (
            <ReportBlockView projectId={projectId} block={block} snapshot={previewSnapshot} preview />
          )}
          {block.mode === 'snapshot' && savedSnapshot && (
            <label className="checkbox-field report-refresh-field">
              <input
                type="checkbox"
                checked={isRefreshRequested}
                onChange={(event) => onRefreshRequestedChange(event.target.checked)}
              />
              {text.reportSnapshotRefresh}
            </label>
          )}
        </>
      )}
      {isPicking && block.type !== 'markdown' && (
        <EmbedPicker
          projectId={projectId}
          initial={block}
          isNew={false}
          onClose={() => setPicking(false)}
          onApply={(next) => {
            setPicking(false);
            onChange(next);
          }}
        />
      )}
    </section>
  );
}

import { useId, useState } from 'react';
import {
  MEDIA_COMPARE_MAX_RUNS,
  REPORT_RUN_TABLE_MAX_ROWS,
  type ReportEmbedBlock,
  type ReportEmbedMode,
  type ReportRunSet,
} from '@mmt/contracts';
import { Dialog } from '../Dialog';
import { ChartPanelEditor } from '../charts/ChartPanelEditor';
import { RunChecklist, RunSetPicker } from './RunSetPicker';
import { ErrorNotice, Loading } from '../Feedback';
import { useMediaCompare } from '../../hooks/useMediaCompare';
import { useRunSetFieldNames, useRunTableMedia } from '../../hooks/useReportBlockData';
import { createBlock, mediaStepsOrLatest, reportBlockProblem } from '../../lib/reportBlocks';
import { metricFieldKey, paramFieldKey } from '../../lib/runAnalysisFields';
import {
  reportBlockProblemLabels,
  reportBlockTypeLabels,
  reportEmbedModeLabels,
} from '../../i18n/reports';
import { text, textTemplates } from '../../i18n/catalog';

type EmbedType = ReportEmbedBlock['type'];
const EMBED_TYPES: EmbedType[] = [
  'chart',
  'parallel_coordinates',
  'parameter_importance',
  'scatter',
  'run_table',
  'media',
  'media_table',
];
// Run list columns besides metrics and params; the name is always shown (components/runs/RunTable).
const RUN_TABLE_BASE_COLUMNS: Array<[string, string]> = [
  ['status', text.status],
  ['created', text.created],
  ['duration', text.duration],
  ['user', text.user],
  ['kind', text.kind],
];
// The chart editor's view-only settings are not stored in a report; it draws them by default.
const CHART_VIEW_SETTINGS = { xScale: 'linear', showRaw: true } as const;

/** Configures one embed: its kind, its Runs, what it draws, and whether its data is fixed. */
export function EmbedPicker({
  projectId,
  initial,
  isNew,
  onApply,
  onClose,
}: {
  projectId: string;
  initial: ReportEmbedBlock;
  isNew: boolean;
  onApply: (block: ReportEmbedBlock) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [block, setBlock] = useState<ReportEmbedBlock>(initial);
  const problem = reportBlockProblem(block);

  function changeType(type: EmbedType) {
    // Keep the chosen Runs and mode; the rest belongs to the previous kind.
    const runSet = 'runSet' in block ? block.runSet : undefined;
    const next = createBlock(type, block.id, runSet) as ReportEmbedBlock;
    setBlock({ ...next, mode: block.mode });
  }
  function changeRunSet(runSet: ReportRunSet) {
    if ('runSet' in block) setBlock({ ...block, runSet });
  }

  return (
    <Dialog
      title={isNew ? text.reportEmbedTitleNew : text.reportEmbedTitleEdit}
      onClose={onClose}
      wide
      className="report-embed-picker"
    >
      {/* Not a form: the chart editor opened from here has its own form, and nested forms submit
          the page natively. */}
      <div className="report-embed-picker-body">
        <label className="field">
          <span>{text.reportEmbedType}</span>
          <select
            aria-label={text.reportEmbedType}
            value={block.type}
            onChange={(event) => changeType(event.target.value as EmbedType)}
          >
            {EMBED_TYPES.map((type) => (
              <option key={type} value={type}>
                {reportBlockTypeLabels[type]}
              </option>
            ))}
          </select>
        </label>
        {'runSet' in block && <RunSetPicker projectId={projectId} runSet={block.runSet} onChange={changeRunSet} />}
        <EmbedFields projectId={projectId} block={block} onChange={setBlock} />
        <fieldset className="report-mode-field">
          <legend>{text.reportModeLabel}</legend>
          <div className="report-segmented" role="radiogroup" aria-label={text.reportModeLabel}>
            {(Object.keys(reportEmbedModeLabels) as ReportEmbedMode[]).map((mode) => (
              <label key={mode} className={block.mode === mode ? 'active' : ''}>
                <input
                  type="radio"
                  name={`${id}-mode`}
                  checked={block.mode === mode}
                  onChange={() => setBlock({ ...block, mode })}
                />
                {reportEmbedModeLabels[mode]}
              </label>
            ))}
          </div>
        </fieldset>
        {problem && <p className="report-block-problem">{reportBlockProblemLabels[problem]}</p>}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            {text.cancel}
          </button>
          <button type="button" className="button primary" disabled={problem !== null} onClick={() => onApply(block)}>
            {text.reportEmbedApply}
          </button>
        </footer>
      </div>
    </Dialog>
  );
}

/** The settings of the chosen kind. */
function EmbedFields({
  projectId,
  block,
  onChange,
}: {
  projectId: string;
  block: ReportEmbedBlock;
  onChange: (block: ReportEmbedBlock) => void;
}) {
  if (block.type === 'media') return <MediaFields projectId={projectId} block={block} onChange={onChange} />;
  if (block.type === 'media_table') return <MediaTableFields projectId={projectId} block={block} onChange={onChange} />;
  return <RunSetFields projectId={projectId} block={block} onChange={onChange} />;
}

type RunSetBlock = Exclude<ReportEmbedBlock, { type: 'media' | 'media_table' }>;

/** Fields chosen from the metric, param and tag names the Run set uses. */
function RunSetFields({
  projectId,
  block,
  onChange,
}: {
  projectId: string;
  block: RunSetBlock;
  onChange: (block: ReportEmbedBlock) => void;
}) {
  const [isEditingChart, setEditingChart] = useState(false);
  const hasRuns = reportBlockProblem(block) !== 'runSetEmpty';
  const names = useRunSetFieldNames(projectId, hasRuns ? block.runSet : null);
  if (!hasRuns) return null;
  if (names.error) return <ErrorNotice message={names.error} retry={names.reload} />;
  if (!names.value) return <Loading />;
  const { metricNames, parameterNames, tagKeys } = names.value;
  const analysisFields = [
    ...parameterNames.map((name) => ({ key: paramFieldKey(name), label: `${text.parameters}: ${name}` })),
    ...metricNames.map((name) => ({ key: metricFieldKey(name), label: `${text.metrics}: ${name}` })),
  ];

  switch (block.type) {
    case 'chart':
      return (
        <div className="field">
          <span>{text.reportChartSettings}</span>
          <div className="report-inline-row">
            <span className="mono">
              {textTemplates.reportChartMetrics(block.panel.metricKeys.join(', ') || text.reportChartMetricsNone)}
            </span>
            <button type="button" className="button small" onClick={() => setEditingChart(true)}>
              {text.reportChartSettings}
            </button>
          </div>
          {isEditingChart && (
            <ChartPanelEditor
              dialogTitle={text.reportChartSettings}
              initial={{ panel: block.panel, view: CHART_VIEW_SETTINGS }}
              metricKeys={metricNames}
              grouping={{ tagKeys, paramKeys: parameterNames }}
              onClose={() => setEditingChart(false)}
              onSave={(draft) => {
                setEditingChart(false);
                onChange({ ...block, panel: { ...draft.panel, id: block.panel.id, layout: block.panel.layout } });
              }}
            />
          )}
        </div>
      );
    case 'parallel_coordinates':
      return (
        <>
          <fieldset className="report-checklist">
            <legend>{text.reportParallelParams}</legend>
            {parameterNames.map((name) => (
              <label key={name} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={block.params?.includes(name) ?? false}
                  onChange={(event) => {
                    const params = block.params ?? [];
                    onChange({
                      ...block,
                      params: event.target.checked ? [...params, name] : params.filter((param) => param !== name),
                    });
                  }}
                />
                <span className="mono">{name}</span>
              </label>
            ))}
          </fieldset>
          <NameSelect
            label={text.reportMetric}
            value={block.metric}
            options={metricNames.map((name) => ({ key: name, label: name }))}
            onChange={(metric) => onChange({ ...block, metric })}
          />
        </>
      );
    case 'parameter_importance': {
      const isSweep = 'sweepId' in block.runSet;
      return (
        <NameSelect
          label={text.reportImportanceTarget}
          value={block.targetMetric ?? ''}
          noneLabel={isSweep ? text.reportSweepObjective : text.none}
          options={metricNames.map((name) => ({ key: name, label: name }))}
          onChange={(targetMetric) => {
            const { targetMetric: _previous, ...rest } = block;
            onChange(targetMetric ? { ...rest, targetMetric } : rest);
          }}
        />
      );
    }
    case 'scatter':
      return (
        <div className="report-field-grid">
          <NameSelect label={text.reportScatterX} value={block.x} options={analysisFields} onChange={(x) => onChange({ ...block, x })} />
          <NameSelect label={text.reportScatterY} value={block.y} options={analysisFields} onChange={(y) => onChange({ ...block, y })} />
          <NameSelect
            label={text.reportScatterColor}
            value={block.color ?? ''}
            options={analysisFields}
            onChange={(color) => {
              const { color: _previous, ...rest } = block;
              onChange(color ? { ...rest, color } : rest);
            }}
          />
        </div>
      );
    case 'run_table': {
      const columns: Array<[string, string]> = [
        ...RUN_TABLE_BASE_COLUMNS,
        ...metricNames.map((name): [string, string] => [metricFieldKey(name), `${text.metrics}: ${name}`]),
        ...parameterNames.map((name): [string, string] => [paramFieldKey(name), `${text.parameters}: ${name}`]),
      ];
      return (
        <>
          <fieldset className="report-checklist">
            <legend>{text.reportRunTableColumns}</legend>
            {columns.map(([key, label]) => (
              <label key={key} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={block.columns.includes(key)}
                  onChange={(event) =>
                    onChange({
                      ...block,
                      columns: event.target.checked ? [...block.columns, key] : block.columns.filter((column) => column !== key),
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>{text.reportRunTableLimit}</span>
            <input
              type="number"
              min={1}
              max={REPORT_RUN_TABLE_MAX_ROWS}
              value={block.limit}
              onChange={(event) =>
                onChange({
                  ...block,
                  limit: Math.max(1, Math.min(REPORT_RUN_TABLE_MAX_ROWS, Math.trunc(Number(event.target.value)) || 1)),
                })
              }
            />
          </label>
        </>
      );
    }
  }
}

function MediaFields({
  projectId,
  block,
  onChange,
}: {
  projectId: string;
  block: Extract<ReportEmbedBlock, { type: 'media' }>;
  onChange: (block: ReportEmbedBlock) => void;
}) {
  const steps = block.steps ?? [];
  const media = useMediaCompare({ projectId, runIds: block.runIds, chosenKey: block.key || null, steps });
  const hasRuns = block.runIds.length > 0;
  return (
    <>
      <fieldset className="report-run-set">
        <legend>{text.reportRunSet}</legend>
        <RunChecklist
          projectId={projectId}
          selectedIds={block.runIds}
          maxCount={MEDIA_COMPARE_MAX_RUNS}
          // Steps recorded by the previous Runs may not exist for the new ones.
          onChange={(runIds) => onChange({ ...block, runIds, steps: undefined })}
        />
      </fieldset>
      {hasRuns && (
        <>
          <ErrorNotice message={media.choices.error} retry={media.choices.reload} />
          <NameSelect
            label={text.reportMediaKey}
            value={block.key}
            noneLabel={media.choices.value?.keys.length === 0 ? text.reportMediaKeyNone : text.none}
            options={(media.choices.value?.keys ?? []).map((summary) => ({ key: summary.key, label: summary.key }))}
            onChange={(key) => onChange({ ...block, key, steps: undefined })}
          />
          {block.key && media.recordedSteps.value && (
            <fieldset className="report-checklist">
              <legend>{text.reportMediaSteps}</legend>
              <small className="muted">{text.reportMediaStepsHint}</small>
              {media.recordedSteps.value.map((step) => (
                <label key={step} className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={steps.includes(step)}
                    onChange={(event) =>
                      onChange({
                        ...block,
                        steps: mediaStepsOrLatest(
                          event.target.checked
                            ? [...steps, step].sort((left, right) => left - right)
                            : steps.filter((item) => item !== step),
                        ),
                      })
                    }
                  />
                  <span className="mono">{step}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
    </>
  );
}

function MediaTableFields({
  projectId,
  block,
  onChange,
}: {
  projectId: string;
  block: Extract<ReportEmbedBlock, { type: 'media_table' }>;
  onChange: (block: ReportEmbedBlock) => void;
}) {
  const tables = useRunTableMedia(projectId, block.runId);
  return (
    <>
      <fieldset className="report-run-set">
        <legend>{text.reportMediaTableRun}</legend>
        <RunChecklist
          projectId={projectId}
          selectedIds={block.runId ? [block.runId] : []}
          maxCount={1}
          mediaKind="table"
          onChange={(runIds) => onChange({ ...block, runId: runIds[0] ?? '', mediaId: '' })}
        />
      </fieldset>
      {block.runId && (
        <>
          <ErrorNotice message={tables.error} retry={tables.reload} />
          <NameSelect
            label={text.reportMediaTable}
            value={block.mediaId}
            noneLabel={tables.value?.length === 0 ? text.reportMediaTableNone : text.none}
            options={(tables.value ?? []).map((media) => ({ key: media.id, label: textTemplates.reportMediaTableOption(media.key, media.step) }))}
            onChange={(mediaId) => onChange({ ...block, mediaId })}
          />
        </>
      )}
    </>
  );
}

function NameSelect({
  label,
  value,
  options,
  noneLabel = text.none,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ key: string; label: string }>;
  noneLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{noneLabel}</option>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

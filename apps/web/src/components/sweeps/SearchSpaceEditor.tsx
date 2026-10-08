import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { SweepMethod } from '@mmt/contracts';
import {
  MAX_GRID_COMBINATIONS,
  SWEEP_DISTRIBUTIONS,
  createSearchSpaceRow,
  type SearchSpaceRow,
  type SearchSpaceRowKind,
  type SweepDistribution,
} from '../../lib/sweepConfig';
import { searchSpaceRowKindLabels } from '../../i18n/sweeps';
import { text, textTemplates } from '../../i18n/catalog';

type EditorMode = 'rows' | 'json';
const JSON_INDENT = 2;

/**
 * The search space as one row per parameter, or a pasted W&B sweep config. Loading the JSON
 * replaces the whole search setting through onLoadWandbConfig, which reports a conversion error.
 */
export function SearchSpaceEditor({
  rows,
  method,
  rowErrors,
  gridCombinations,
  createRowId,
  onRowsChange,
  currentWandbConfig,
  onLoadWandbConfig,
}: {
  rows: SearchSpaceRow[];
  method: SweepMethod;
  rowErrors: Record<string, string>;
  /** null when the space has a range parameter (or the method is not grid). */
  gridCombinations: number | null;
  createRowId: () => string;
  onRowsChange: (rows: SearchSpaceRow[]) => void;
  currentWandbConfig: () => Record<string, unknown> | null;
  onLoadWandbConfig: (config: unknown) => string | null;
}) {
  const [mode, setMode] = useState<EditorMode>('rows');
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const changeRow = (id: string, change: Partial<SearchSpaceRow>) =>
    onRowsChange(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));

  function openJson() {
    const config = currentWandbConfig();
    if (config) setJson(JSON.stringify(config, null, JSON_INDENT));
    setJsonError(null);
    setMode('json');
  }
  function loadJson() {
    let config: unknown;
    try {
      config = JSON.parse(json);
    } catch {
      setJsonError(text.jsonError);
      return;
    }
    const error = onLoadWandbConfig(config);
    setJsonError(error);
    if (!error) setMode('rows');
  }

  return (
    <fieldset className="sweep-space-editor">
      <legend>{text.sweepSearchSpace}</legend>
      <div className="sweep-editor-modes" role="group" aria-label={text.sweepSearchSpace}>
        <button type="button" className={`button small${mode === 'rows' ? ' primary' : ''}`} aria-pressed={mode === 'rows'}
          onClick={() => setMode('rows')}>{text.sweepEditorRows}</button>
        <button type="button" className={`button small${mode === 'json' ? ' primary' : ''}`} aria-pressed={mode === 'json'}
          onClick={openJson}>{text.sweepEditorJson}</button>
      </div>
      {mode === 'json' ? (
        <div className="sweep-json-editor">
          <p className="muted">{text.sweepJsonHint}</p>
          <textarea aria-label={text.sweepEditorJson} className="mono" rows={14} value={json}
            onChange={(event) => setJson(event.target.value)} />
          {jsonError && <p className="sweep-field-error" role="alert">{jsonError}</p>}
          <button type="button" className="button small" onClick={loadJson}>{text.sweepJsonLoad}</button>
        </div>
      ) : (
        <>
          <div className="sweep-space-rows">
            {rows.map((row) => (
              <SearchSpaceRowFields key={row.id} row={row} error={rowErrors[row.id]}
                onChange={(change) => changeRow(row.id, change)}
                onRemove={() => onRowsChange(rows.filter((item) => item.id !== row.id))} />
            ))}
          </div>
          <button type="button" className="button small" onClick={() => onRowsChange([...rows, createSearchSpaceRow(createRowId())])}>
            <Plus size={13} />{text.sweepAddParameter}
          </button>
        </>
      )}
      {method === 'grid' && gridCombinations !== null && <GridCombinationCount count={gridCombinations} />}
    </fieldset>
  );
}

function GridCombinationCount({ count }: { count: number }) {
  return count > MAX_GRID_COMBINATIONS ? (
    <p className="sweep-field-error" role="alert" data-testid="sweep-grid-count">
      {textTemplates.sweepGridTooMany(count, MAX_GRID_COMBINATIONS)}
    </p>
  ) : (
    <p className="muted" data-testid="sweep-grid-count">{textTemplates.sweepGridCombinations(count)}</p>
  );
}

function SearchSpaceRowFields({
  row,
  error,
  onChange,
  onRemove,
}: {
  row: SearchSpaceRow;
  error: string | undefined;
  onChange: (change: Partial<SearchSpaceRow>) => void;
  onRemove: () => void;
}) {
  const label = row.name || text.sweepParameterName;
  return (
    <div className={`sweep-space-row${error ? ' invalid' : ''}`} data-testid="sweep-space-row">
      <label className="field"><span>{text.sweepParameterName}</span>
        <input value={row.name} className="mono" aria-invalid={Boolean(error)}
          onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      <label className="field"><span>{text.sweepParameterKind}</span>
        <select value={row.kind} onChange={(event) => onChange({ kind: event.target.value as SearchSpaceRowKind })}>
          {(Object.keys(searchSpaceRowKindLabels) as SearchSpaceRowKind[]).map((kind) => (
            <option key={kind} value={kind}>{searchSpaceRowKindLabels[kind]}</option>
          ))}
        </select>
      </label>
      {row.kind === 'values' && (
        <label className="field sweep-space-wide"><span>{text.sweepParameterValues}</span>
          <input value={row.values} className="mono" placeholder="0.001, 0.01, 0.1"
            onChange={(event) => onChange({ values: event.target.value })} />
        </label>
      )}
      {row.kind === 'constant' && (
        <label className="field sweep-space-wide"><span>{text.sweepParameterValue}</span>
          <input value={row.value} className="mono" onChange={(event) => onChange({ value: event.target.value })} />
        </label>
      )}
      {row.kind === 'range' && (
        <>
          <label className="field"><span>{text.sweepDistribution}</span>
            <select value={row.distribution} onChange={(event) => onChange({ distribution: event.target.value as SweepDistribution })}>
              {SWEEP_DISTRIBUTIONS.map((distribution) => <option key={distribution} value={distribution}>{distribution}</option>)}
            </select>
          </label>
          <label className="field"><span>{text.sweepMin}</span>
            <input value={row.min} className="mono" inputMode="decimal" onChange={(event) => onChange({ min: event.target.value })} />
          </label>
          <label className="field"><span>{text.sweepMax}</span>
            <input value={row.max} className="mono" inputMode="decimal" onChange={(event) => onChange({ max: event.target.value })} />
          </label>
          {row.distribution === 'q_uniform' && (
            <label className="field"><span>{text.sweepQ}</span>
              <input value={row.q} className="mono" inputMode="decimal" onChange={(event) => onChange({ q: event.target.value })} />
            </label>
          )}
        </>
      )}
      <button type="button" className="icon-button" aria-label={`${text.sweepRemoveParameter}: ${label}`} onClick={onRemove}>
        <Trash2 size={15} />
      </button>
      {error && <p className="sweep-field-error sweep-space-error" role="alert">{error}</p>}
    </div>
  );
}

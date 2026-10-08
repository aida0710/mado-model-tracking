import { useState } from 'react';
import type { ParameterImportanceEntry, ParameterImportanceResult } from '@mmt/contracts';
import { text, textTemplates } from '../../i18n/catalog';
import {
  analysisParamKindLabels,
  importanceTargetSourceLabels,
  importanceUnavailableReasonLabels,
  parameterExclusionReasonLabels,
} from '../../i18n/analysis';
import { formatCompactNumber } from '../../lib/format';
import { Empty } from '../Feedback';

export type ImportanceMethod = 'impurity' | 'permutation';
type SortColumn = 'param' | 'importance' | 'correlation' | 'coverage';

const PERCENT = 100;

function importanceOf(entry: ParameterImportanceEntry, method: ImportanceMethod): number | null {
  return method === 'impurity' ? entry.importance : entry.permutationImportance;
}

function sortValue(entry: ParameterImportanceEntry, column: SortColumn, method: ImportanceMethod) {
  if (column === 'param') return entry.param;
  if (column === 'correlation') return entry.correlation === null ? null : Math.abs(entry.correlation);
  if (column === 'coverage') return entry.coverage;
  return importanceOf(entry, method);
}

/** Sorted copy; entries without a value go last in either direction. */
function sortEntries(
  entries: ParameterImportanceEntry[],
  sort: { column: SortColumn; descending: boolean },
  method: ImportanceMethod,
): ParameterImportanceEntry[] {
  const direction = sort.descending ? -1 : 1;
  return [...entries].sort((left, right) => {
    const a = sortValue(left, sort.column, method);
    const b = sortValue(right, sort.column, method);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    if (typeof a === 'string' || typeof b === 'string') return direction * String(a).localeCompare(String(b));
    return direction * (a - b);
  });
}

function formatOptional(value: number | null): string {
  return value === null ? '—' : formatCompactNumber(value);
}

/** Parameter importance as returned by the API, with the method and sort chosen on screen. */
export function ParameterImportanceTable({ result }: { result: ParameterImportanceResult }) {
  const [method, setMethod] = useState<ImportanceMethod>('impurity');
  // null keeps the API order: most important first (by |correlation| while importance is null).
  const [sort, setSort] = useState<{ column: SortColumn; descending: boolean } | null>(null);
  const entries = sort ? sortEntries(result.entries, sort, method) : result.entries;
  const maxImportance = Math.max(0, ...result.entries.map((entry) => importanceOf(entry, method) ?? 0));

  function sortHeader(column: SortColumn, label: string) {
    const active = sort?.column === column;
    const descending = active ? !sort.descending : column !== 'param';
    return (
      <th aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
        <button type="button" className="analysis-sort-button" onClick={() => setSort({ column, descending })}>
          {label}
          {active && <span aria-hidden="true">{sort.descending ? ' ▼' : ' ▲'}</span>}
        </button>
      </th>
    );
  }

  return (
    <div className="importance-table">
      <div className="importance-summary">
        <span>
          {text.analysisTarget}: <strong>{result.targetMetric}</strong>（{importanceTargetSourceLabels[result.targetSource]}）
        </span>
        <span>{textTemplates.analysisRunCount(result.runCount, result.skippedRunCount)}</span>
        {result.outOfBagR2 !== null && (
          <span>{textTemplates.analysisOutOfBagR2(formatCompactNumber(result.outOfBagR2))}</span>
        )}
        <fieldset className="importance-method" disabled={result.importanceUnavailableReason !== null}>
          <legend>{text.analysisImportanceMethod}</legend>
          {(['impurity', 'permutation'] as const).map((value) => (
            <label key={value}>
              <input type="radio" name="importance-method" checked={method === value} onChange={() => setMethod(value)} />
              {value === 'impurity' ? text.analysisImportanceImpurity : text.analysisImportancePermutation}
            </label>
          ))}
        </fieldset>
      </div>
      {result.importanceUnavailableReason && (
        <p className="analysis-notice" role="note">
          {importanceUnavailableReasonLabels[result.importanceUnavailableReason]}
        </p>
      )}
      {entries.length === 0 ? (
        <Empty>{text.analysisNoParams}</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {sortHeader('param', text.analysisParam)}
                <th>{text.analysisKind}</th>
                {sortHeader('importance', text.analysisImportanceColumn)}
                {sortHeader('correlation', text.analysisCorrelation)}
                {sortHeader('coverage', text.analysisCoverage)}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const importance = importanceOf(entry, method);
                return (
                  <tr key={entry.param} data-param={entry.param}>
                    <td className="mono">{entry.param}</td>
                    <td>{analysisParamKindLabels[entry.kind]}</td>
                    <td>
                      <span className="importance-bar-cell">
                        <span className="importance-bar-track">
                          {importance !== null && maxImportance > 0 && (
                            <span
                              className="importance-bar"
                              style={{ width: `${(Math.max(0, importance) / maxImportance) * PERCENT}%` }}
                            />
                          )}
                        </span>
                        <span className="importance-value">{formatOptional(importance)}</span>
                      </span>
                    </td>
                    <td>
                      <CorrelationCell correlation={entry.correlation} />
                    </td>
                    <td>{`${Math.round(entry.coverage * PERCENT)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {result.excluded.length > 0 && (
        <details className="importance-excluded">
          <summary>{`${text.analysisExcluded} (${result.excluded.length})`}</summary>
          <ul>
            {result.excluded.map((item) => (
              <li key={item.param}>
                <span className="mono">{item.param}</span>: {parameterExclusionReasonLabels[item.reason]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A bar from the center: right and blue for positive, left and red for negative. */
function CorrelationCell({ correlation }: { correlation: number | null }) {
  if (correlation === null) return <span className="importance-value">—</span>;
  const width = Math.min(1, Math.abs(correlation)) * (PERCENT / 2);
  return (
    <span className="importance-bar-cell">
      <span className="correlation-track">
        <span
          className={correlation >= 0 ? 'correlation-bar positive' : 'correlation-bar negative'}
          style={correlation >= 0 ? { left: '50%', width: `${width}%` } : { right: '50%', width: `${width}%` }}
        />
      </span>
      <span className="importance-value">{formatCompactNumber(correlation)}</span>
    </span>
  );
}

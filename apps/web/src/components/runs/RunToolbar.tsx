import { useEffect, useState } from 'react';
import { Columns3, Download, Search } from 'lucide-react';
import type { RunStatus } from '@mmt/contracts';
import { ErrorNotice } from '../Feedback';
import {
  findRunFilterSyntaxError,
  metricRunSort,
  parseMetricRunSort,
  toRunSearchConditions,
} from '../../lib/runFilter';
import { text, textTemplates } from '../../i18n/catalog';

const runStatuses: RunStatus[] = ['queued', 'running', 'finished', 'failed', 'canceled'];

export function RunToolbar({
  searchText,
  status,
  sort,
  metricNames,
  columnNames,
  isColumnVisible,
  onSearch,
  onStatusChange,
  onSortChange,
  onColumnToggle,
  exportingCsv,
  onExportCsv,
}: {
  searchText: string;
  status: string;
  sort: string;
  metricNames: string[];
  columnNames: string[];
  isColumnVisible: (name: string) => boolean;
  onSearch: (searchText: string) => void;
  onStatusChange: (status: string) => void;
  onSortChange: (sort: string) => void;
  onColumnToggle: (name: string) => void;
  exportingCsv: boolean;
  /** Exports every Run of the current search, not only the shown page. */
  onExportCsv: () => void;
}) {
  const [searchInput, setSearchInput] = useState(searchText);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  useEffect(() => {
    setSearchInput(searchText);
    setSyntaxError(null);
  }, [searchText]);
  const sortedMetric = parseMetricRunSort(sort);
  // Keep the current metric order selectable even when this page lacks that metric.
  const sortMetricNames =
    sortedMetric && !metricNames.includes(sortedMetric.key)
      ? [sortedMetric.key, ...metricNames]
      : metricNames;

  function submitSearch() {
    const conditions = toRunSearchConditions(searchInput);
    const error = 'filter' in conditions ? findRunFilterSyntaxError(conditions.filter) : null;
    setSyntaxError(error);
    if (!error) onSearch(searchInput.trim());
  }

  return (
    <>
      <div className="run-toolbar">
        <form
          className="search-field"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <Search size={16} />
          <input
            aria-label={text.search}
            aria-invalid={syntaxError ? true : undefined}
            placeholder={text.queryHint}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <button className="button small" type="submit">
            {text.filter}
          </button>
        </form>
        <label className="toolbar-select">
          <span>{text.status}</span>
          <select
            aria-label={text.status}
            value={status}
            onChange={(event) => onStatusChange(event.target.value)}
          >
            <option value="">{text.allStatus}</option>
            {runStatuses.map((value) => (
              <option key={value} value={value}>
                {text[value]}
              </option>
            ))}
          </select>
        </label>
        <details className="column-menu">
          <summary>
            <Columns3 size={15} />
            {text.columns}
          </summary>
          <div className="popover">
            {columnNames.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={isColumnVisible(name)}
                  onChange={() => onColumnToggle(name)}
                />
                {name in text ? text[name as keyof typeof text] : name}
              </label>
            ))}
          </div>
        </details>
        <label className="toolbar-select">
          <span>{text.sort}</span>
          <select
            aria-label={text.sort}
            value={sort}
            onChange={(event) => onSortChange(event.target.value)}
          >
            <option value="newest">{text.newest}</option>
            <option value="oldest">{text.oldest}</option>
            <option value="name">{text.byName}</option>
            {sortMetricNames.flatMap((name) => [
              <option key={`${name}:desc`} value={metricRunSort(name, 'desc')}>
                {textTemplates.metricDescending(`metrics.${name}`)}
              </option>,
              <option key={`${name}:asc`} value={metricRunSort(name, 'asc')}>
                {textTemplates.metricAscending(`metrics.${name}`)}
              </option>,
            ])}
          </select>
        </label>
        <button
          className="button small"
          type="button"
          disabled={exportingCsv}
          onClick={onExportCsv}
        >
          <Download size={15} />
          {exportingCsv ? text.exportingRunsCsv : text.exportRunsCsv}
        </button>
      </div>
      <ErrorNotice message={syntaxError} />
    </>
  );
}

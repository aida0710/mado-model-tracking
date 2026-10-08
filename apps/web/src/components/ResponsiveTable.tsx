import { Fragment, useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Empty } from './Feedback';
import { NARROW_QUERY } from '../lib/breakpoints';
import { splitColumnsByPriority, type ColumnPriority } from '../lib/responsiveColumns';
import { useMediaQuery } from '../lib/useMediaQuery';
import { responsiveText } from '../i18n/responsive';

export interface ResponsiveColumn<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  priority: ColumnPriority;
  className?: string;
}

interface ResponsiveTableProps<Row> {
  columns: ResponsiveColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  selectedKey?: string;
  empty?: ReactNode;
}

/** A table that keeps only its primary columns below --bp-md; opening a row shows the rest. */
export function ResponsiveTable<Row>(props: ResponsiveTableProps<Row>) {
  const isNarrow = useMediaQuery(NARROW_QUERY);
  return <ResponsiveTableLayout {...props} isNarrow={isNarrow} />;
}

/** The table for a known width; ResponsiveTable passes the current one. */
export function ResponsiveTableLayout<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  isNarrow,
}: ResponsiveTableProps<Row> & { isNarrow: boolean }) {
  const tableId = useId();
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  if (!rows.length) return <Empty>{empty}</Empty>;
  const { shown, folded } = splitColumnsByPriority(columns, isNarrow);
  const toggle = (key: string) =>
    setOpenKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="table-scroll">
      <table className={isNarrow ? 'responsive-table narrow' : 'responsive-table'}>
        <thead>
          <tr>
            {folded.length > 0 && (
              <th scope="col" className="row-toggle-cell">
                <span className="sr-only">{responsiveText.showRowDetails}</span>
              </th>
            )}
            {shown.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const isOpen = openKeys.has(key);
            const detailsId = `${tableId}-details-${key}`;
            return (
              <Fragment key={key}>
                <tr
                  className={selectedKey === key ? 'selected' : ''}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {folded.length > 0 && (
                    <td className="row-toggle-cell">
                      <button
                        type="button"
                        className="icon-button row-toggle"
                        aria-expanded={isOpen}
                        aria-controls={detailsId}
                        aria-label={isOpen ? responsiveText.hideRowDetails : responsiveText.showRowDetails}
                        onClick={(event) => {
                          // Opening the details is not choosing the row.
                          event.stopPropagation();
                          toggle(key);
                        }}
                      >
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </td>
                  )}
                  {shown.map((column) => (
                    <td key={column.key} className={column.className}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {isOpen && folded.length > 0 && (
                  <tr className="row-details" id={detailsId}>
                    <td colSpan={shown.length + 1}>
                      <dl className="row-details-list">
                        {folded.map((column) => (
                          <div key={column.key}>
                            <dt>{column.header}</dt>
                            <dd className={column.className}>{column.render(row)}</dd>
                          </div>
                        ))}
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

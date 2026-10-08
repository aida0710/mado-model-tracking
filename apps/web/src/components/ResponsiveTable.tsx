import { Fragment, useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Empty } from './Feedback';
import { NARROW_LAYOUT_QUERY } from '../lib/breakpoints';
import { useMediaQuery } from '../lib/useMediaQuery';
import { splitColumnsByPriority, type ColumnPriority } from '../lib/responsiveTableColumns';
import { text } from '../i18n/catalog';

export interface ResponsiveTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Narrow layouts keep primary columns as cells and show secondary ones when the row opens. */
  priority: ColumnPriority;
  className?: string;
}

interface ResponsiveTableProps<T> {
  columns: ResponsiveTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  empty?: ReactNode;
}

/** A table that, below --bp-md, keeps only its primary columns and opens rows for the rest. */
export function ResponsiveTable<T>(props: ResponsiveTableProps<T>) {
  const narrow = useMediaQuery(NARROW_LAYOUT_QUERY);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRow = (key: string) =>
    setOpenKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <ResponsiveTableView {...props} narrow={narrow} openKeys={openKeys} onToggleRow={toggleRow} />
  );
}

/** The markup of ResponsiveTable for a given layout and set of open rows. */
export function ResponsiveTableView<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  narrow,
  openKeys,
  onToggleRow,
}: ResponsiveTableProps<T> & {
  narrow: boolean;
  openKeys: ReadonlySet<string>;
  onToggleRow: (key: string) => void;
}) {
  const detailsIdPrefix = useId();
  if (!rows.length) return <Empty>{empty}</Empty>;
  const { cellColumns, detailColumns } = splitColumnsByPriority(columns, narrow);
  const hasDetails = detailColumns.length > 0;
  return (
    <div className={`table-scroll responsive-table${narrow ? ' narrow' : ''}`}>
      <table>
        <thead>
          <tr>
            {cellColumns.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.header}
              </th>
            ))}
            {hasDetails && (
              <th scope="col" className="responsive-table-toggle">
                <span className="sr-only">{text.rowDetails}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const open = hasDetails && openKeys.has(key);
            const detailsId = `${detailsIdPrefix}-${key}`;
            return (
              <Fragment key={key}>
                <tr
                  className={selectedKey === key ? 'selected' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {cellColumns.map((column) => (
                    <td key={column.key} className={column.className}>
                      {column.render(row)}
                    </td>
                  ))}
                  {hasDetails && (
                    <td className="responsive-table-toggle">
                      <button
                        type="button"
                        className="icon-button"
                        aria-expanded={open}
                        aria-controls={open ? detailsId : undefined}
                        aria-label={open ? text.hideRowDetails : text.showRowDetails}
                        onClick={(event) => {
                          // Opening a row must not also count as choosing it.
                          event.stopPropagation();
                          onToggleRow(key);
                        }}
                      >
                        {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                      </button>
                    </td>
                  )}
                </tr>
                {open && (
                  <tr className="responsive-table-details" id={detailsId}>
                    <td colSpan={cellColumns.length + 1}>
                      <dl>
                        {detailColumns.map((column) => (
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

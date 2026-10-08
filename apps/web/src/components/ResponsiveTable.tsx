import { Fragment, useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Empty } from './Feedback';
import { useIsNarrow } from '../lib/useMediaQuery';
import { responsiveTableColumns, type ResponsiveColumnPriority } from '../lib/responsiveTableColumns';
import { responsiveTableText } from '../i18n/responsiveTable';

export interface ResponsiveTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  priority: ResponsiveColumnPriority;
  className?: string;
}

export interface ResponsiveTableProps<T> {
  columns: ResponsiveTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  isSelected?: (row: T) => boolean;
  empty?: ReactNode;
}

/**
 * A table that keeps only its primary columns on a narrow screen; each row then has a toggle that
 * shows the secondary columns under it. On a wide screen it is a plain table that scrolls inside
 * itself when it is wider than its container.
 */
export function ResponsiveTable<T>(props: ResponsiveTableProps<T>) {
  const isNarrow = useIsNarrow();
  return <ResponsiveTableView {...props} isNarrow={isNarrow} />;
}

/** The table for a known width, separate from the media query so either layout can be rendered. */
export function ResponsiveTableView<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  isSelected,
  empty,
  isNarrow,
}: ResponsiveTableProps<T> & { isNarrow: boolean }) {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  const detailsIdPrefix = useId();
  if (!rows.length) return <Empty>{empty}</Empty>;
  const { cells, details } = responsiveTableColumns(columns, isNarrow);
  const toggle = (key: string) =>
    setOpenKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className={`table-scroll responsive-table ${isNarrow ? 'narrow' : ''}`.trim()}>
      <table>
        <thead>
          <tr>
            {cells.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.header}
              </th>
            ))}
            {details.length > 0 && (
              <th scope="col" className="responsive-table-toggle-cell">
                <span className="sr-only">{responsiveTableText.responsiveTableShowDetails}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const isOpen = openKeys.has(key);
            const detailsId = `${detailsIdPrefix}-${key}`;
            const selected = selectedKey === key || isSelected?.(row);
            return (
              <Fragment key={key}>
                <tr
                  className={selected ? 'selected' : ''}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {cells.map((column) => (
                    <td key={column.key} className={column.className}>
                      {column.render(row)}
                    </td>
                  ))}
                  {details.length > 0 && (
                    <td className="responsive-table-toggle-cell">
                      <button
                        type="button"
                        className="icon-button responsive-table-toggle"
                        aria-expanded={isOpen}
                        aria-controls={detailsId}
                        aria-label={
                          isOpen
                            ? responsiveTableText.responsiveTableHideDetails
                            : responsiveTableText.responsiveTableShowDetails
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(key);
                        }}
                      >
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </td>
                  )}
                </tr>
                {details.length > 0 && isOpen && (
                  <ResponsiveTableDetails
                    id={detailsId}
                    row={row}
                    columns={details}
                    colSpan={cells.length + 1}
                    selected={!!selected}
                  />
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The secondary columns of one row, as label and value pairs under it. */
export function ResponsiveTableDetails<T>({
  id,
  row,
  columns,
  colSpan,
  selected = false,
}: {
  id: string;
  row: T;
  columns: ResponsiveTableColumn<T>[];
  colSpan: number;
  selected?: boolean;
}) {
  return (
    <tr id={id} className={`responsive-table-details ${selected ? 'selected' : ''}`.trim()}>
      <td colSpan={colSpan}>
        <dl>
          {columns.map((column) => (
            <div key={column.key}>
              <dt>{column.header}</dt>
              <dd className={column.className}>{column.render(row)}</dd>
            </div>
          ))}
        </dl>
      </td>
    </tr>
  );
}

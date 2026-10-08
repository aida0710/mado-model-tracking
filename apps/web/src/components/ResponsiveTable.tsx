import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Empty } from './Feedback';
import { narrowerThan } from '../lib/breakpoints';
import { splitColumnsByPriority, type ColumnPriority } from '../lib/responsiveColumns';
import { useMediaQuery } from '../lib/useMediaQuery';
import { text } from '../i18n/catalog';

export interface ResponsiveTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** primary columns stay in the row on narrow screens; secondary ones move into the opened row. */
  priority: ColumnPriority;
  className?: string;
}

export interface ResponsiveTableProps<T> {
  columns: ResponsiveTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** A pointer shortcut; keep a link or button in a primary column for keyboard users. */
  onRowClick?: (row: T) => void;
  /** The key of the row the screen has chosen (for example the one shown in a side panel). */
  selectedKey?: string;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  /** Accessible name of the table when no heading names it. */
  label?: string;
}

// Controls inside a cell keep their own action; only clicks on the row's plain text open the row.
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, label, summary';

function isFromCellControl(event: MouseEvent<HTMLElement>) {
  const control = (event.target as Element).closest(INTERACTIVE_SELECTOR);
  return control !== null && event.currentTarget.contains(control);
}

function rowClassName({ isClickable, isSelected }: { isClickable: boolean; isSelected: boolean }) {
  return [isClickable && 'clickable-row', isSelected && 'selected'].filter(Boolean).join(' ') || undefined;
}

/**
 * A table for lists that must fit a phone: below --bp-md only the primary columns stay in the row
 * and a button on each row opens the secondary ones beneath it.
 */
export function ResponsiveTable<T>(props: ResponsiveTableProps<T>) {
  const isNarrow = useMediaQuery(narrowerThan('md'));
  return <ResponsiveTableView {...props} isNarrow={isNarrow} />;
}

/** The table for a known width; split from ResponsiveTable so tests can render both layouts. */
export function ResponsiveTableView<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  label,
  isNarrow,
}: ResponsiveTableProps<T> & { isNarrow: boolean }) {
  const detailIdPrefix = useId();
  const [openRowKeys, setOpenRowKeys] = useState<ReadonlySet<string>>(new Set());
  if (!rows.length) return <Empty>{empty}</Empty>;
  const { rowColumns, detailColumns } = splitColumnsByPriority(columns, isNarrow);
  const hasDetails = detailColumns.length > 0;
  const toggleRow = (key: string) =>
    setOpenRowKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="table-scroll">
      <table className="responsive-table" aria-label={label}>
        <thead>
          <tr>
            {rowColumns.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.header}
              </th>
            ))}
            {hasDetails && (
              <th scope="col" className="responsive-table-toggle">
                <span className="sr-only">{text.showRowDetails}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row);
            const isOpen = hasDetails && openRowKeys.has(key);
            const detailId = `${detailIdPrefix}-${index}`;
            return [
              <tr
                key={key}
                className={rowClassName({ isClickable: Boolean(onRowClick), isSelected: key === selectedKey })}
                onClick={
                  onRowClick &&
                  ((event) => {
                    if (!isFromCellControl(event)) onRowClick(row);
                  })
                }
              >
                {rowColumns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render(row)}
                  </td>
                ))}
                {hasDetails && (
                  <td className="responsive-table-toggle">
                    <button
                      type="button"
                      className="icon-button"
                      aria-expanded={isOpen}
                      aria-controls={detailId}
                      aria-label={isOpen ? text.hideRowDetails : text.showRowDetails}
                      onClick={() => toggleRow(key)}
                    >
                      {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                    </button>
                  </td>
                )}
              </tr>,
              isOpen && (
                <tr key={`${key}-details`} id={detailId} className="responsive-table-details">
                  <td colSpan={rowColumns.length + 1}>
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
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

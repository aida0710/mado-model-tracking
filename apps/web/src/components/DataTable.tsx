import type { ReactNode } from 'react';
import { Empty } from './Feedback';

export interface TableColumn<T> {
  key: string;
  label: ReactNode;
  render: (item: T) => ReactNode;
  className?: string;
}
export function DataTable<T>({
  items,
  columns,
  rowKey,
  selectedKey,
  isSelected,
  empty,
}: {
  items: T[];
  columns: TableColumn<T>[];
  rowKey: (item: T) => string;
  selectedKey?: string;
  isSelected?: (item: T) => boolean;
  empty?: ReactNode;
}) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={rowKey(item)}
              className={selectedKey === rowKey(item) || isSelected?.(item) ? 'selected' : ''}
            >
              {columns.map((column) => (
                <td key={column.key} className={column.className}>
                  {column.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

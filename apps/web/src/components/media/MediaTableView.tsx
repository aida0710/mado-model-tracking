import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { runMediaApi } from '../../api/runMedia';
import { useExclusiveAudio } from '../../hooks/useExclusiveAudio';
import { useQuery } from '../../hooks/useQuery';
import { countErrorCells, MEDIA_TABLE_PAGE_SIZE, tablePageCount } from '../../lib/mediaTableCells';
import { Resource } from '../Feedback';
import { MediaCell } from './MediaCell';
import { text, textTemplates } from '../../i18n/catalog';

/**
 * A media table (MLflow log_table or a native table) read a page at a time from the API, which
 * resolves media cells to Artifacts. MLflow and native tables share the format, so they look the same.
 */
export function MediaTableView({ projectId, runId, mediaId }: { projectId: string; runId: string; mediaId: string }) {
  const [page, setPage] = useState(0);
  const exclusiveAudio = useExclusiveAudio();
  const table = useQuery(`${projectId}:media-table:${runId}:${mediaId}:${page}`, (signal) =>
    runMediaApi.table(projectId, { runId, mediaId }, { offset: page * MEDIA_TABLE_PAGE_SIZE, limit: MEDIA_TABLE_PAGE_SIZE }, signal),
  );
  return (
    <Resource query={table}>
      {(current) => {
        const pageCount = tablePageCount(current.totalRows);
        const errorCells = countErrorCells(current.columns, current.rows);
        return (
          <div className="media-table">
            <div className="media-table-toolbar">
              <span>{textTemplates.mediaTableRowCount(current.totalRows)}</span>
              {errorCells > 0 && <span className="sample-error">{textTemplates.mediaTableErrorCells(errorCells)}</span>}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="mono">#</th>
                    {current.columns.map((column) => (
                      <th key={column.name}>{column.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.rows.map((row, rowIndex) => {
                    const rowNumber = page * MEDIA_TABLE_PAGE_SIZE + rowIndex;
                    return (
                      <tr key={rowNumber}>
                        <td className="mono muted">{rowNumber + 1}</td>
                        {current.columns.map((column, columnIndex) => (
                          <td key={column.name}>
                            <MediaCell
                              projectId={projectId}
                              column={column}
                              value={row[columnIndex]}
                              playback={{ exclusiveAudio, cellId: `${rowNumber}:${columnIndex}` }}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pageCount > 1 && (
              <nav className="media-table-pager" aria-label={text.mediaTablePagination}>
                <button
                  type="button"
                  className="button small"
                  onClick={() => setPage(page - 1)}
                  disabled={page === 0}
                  aria-label={text.previousPage}
                >
                  <ChevronLeft size={14} />
                </button>
                <span>{textTemplates.mediaTablePage(page + 1, pageCount)}</span>
                <button
                  type="button"
                  className="button small"
                  onClick={() => setPage(page + 1)}
                  disabled={page >= pageCount - 1}
                  aria-label={text.nextPage}
                >
                  <ChevronRight size={14} />
                </button>
              </nav>
            )}
          </div>
        );
      }}
    </Resource>
  );
}

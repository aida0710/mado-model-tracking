import { text, textTemplates } from '../../i18n/catalog';

/** Cursor paging: the total is unknown, so it shows the page number and the way back. */
export function RunPagination({
  pageNumber,
  shownCount,
  pageSize,
  hasNextPage,
  onFirst,
  onPrevious,
  onNext,
}: {
  pageNumber: number;
  shownCount: number;
  pageSize: number;
  hasNextPage: boolean;
  onFirst: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const isFirstPage = pageNumber === 1;
  return (
    <div className="table-footer">
      <span>
        {textTemplates.runCount(shownCount)} · {pageSize} / {text.page}
      </span>
      <span>
        {textTemplates.pageNumber(pageNumber)}
        <button
          className="icon-button"
          disabled={isFirstPage}
          aria-label={text.firstPage}
          onClick={onFirst}
        >
          «
        </button>
        <button
          className="icon-button"
          disabled={isFirstPage}
          aria-label={text.previousPage}
          onClick={onPrevious}
        >
          ‹
        </button>
        <button
          className="icon-button"
          disabled={!hasNextPage}
          aria-label={text.nextPage}
          onClick={onNext}
        >
          ›
        </button>
      </span>
    </div>
  );
}

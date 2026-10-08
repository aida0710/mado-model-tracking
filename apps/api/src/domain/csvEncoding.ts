/**
 * CSV text for spreadsheet users (RFC 4180): CRLF line ends, fields quoted when they hold a
 * comma, quote, CR or LF, and a UTF-8 BOM so Excel reads Japanese text without mojibake.
 */

// decisions.md adopted the BOM for Excel. Set to '' to emit plain UTF-8 instead.
export const CSV_BYTE_ORDER_MARK = '\uFEFF';
export const CSV_LINE_END = '\r\n';
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

// A spreadsheet evaluates text starting with these as a formula (CSV injection, OWASP).
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * A number is written as is, including NaN and ±Infinity, so numeric metrics such as -0.5 keep
 * their value. Only text gets the formula guard; null and undefined are empty cells.
 */
export type CsvCell = string | number | boolean | null | undefined;

export function encodeCsvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  const guarded = FORMULA_TRIGGER.test(cell) ? `'${cell}` : cell;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function encodeCsvLine(cells: readonly CsvCell[]): string {
  return cells.map(encodeCsvCell).join(',') + CSV_LINE_END;
}

export function encodeCsvDocument(lines: readonly (readonly CsvCell[])[]): string {
  return CSV_BYTE_ORDER_MARK + lines.map(encodeCsvLine).join('');
}

/** attachment with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function csvAttachmentDisposition(fileName: string): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

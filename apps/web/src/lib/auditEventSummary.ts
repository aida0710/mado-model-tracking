import type { JsonObject } from '@mmt/contracts';
import { formatValue } from './format';

// Keeps a table cell to one line; the full JSON stays available in the cell title.
const MAX_DETAILS_SUMMARY_LENGTH = 120;

function formatDetailValue(value: unknown): string {
  return Array.isArray(value) ? value.map(formatValue).join(', ') : formatValue(value);
}

export function summarizeAuditDetails(details: JsonObject): string {
  const summary = Object.entries(details)
    .map(([key, value]) => `${key}: ${formatDetailValue(value)}`)
    .join(' / ');
  return summary.length > MAX_DETAILS_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_DETAILS_SUMMARY_LENGTH - 1)}…`
    : summary;
}

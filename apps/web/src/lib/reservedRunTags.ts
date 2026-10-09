import { parseStringMap } from './formValues';
import { automationText } from '../i18n/automation';

// Mirrors RESERVED_RUN_TAG_PREFIXES in the API (domain/reservedRunTags.ts): the server sets these
// tags on the Runs it starts (automation rules, hooks, arrays), so a request may not carry them.
const RESERVED_TAG_PREFIXES = ['automation.', 'mmt.'] as const;

/** Tags a person gives the Runs a rule or hook starts, as a JSON object of strings. */
export function parseUserRunTags(value: string): Record<string, string> {
  const tags = parseStringMap(value);
  const reserved = Object.keys(tags).find((key) =>
    RESERVED_TAG_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  if (reserved !== undefined) throw new Error(automationText.reservedTag(reserved));
  return tags;
}

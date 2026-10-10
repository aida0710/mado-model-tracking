import { MAX_SITE_VARIABLES, SITE_VARIABLE_NAME_PATTERN } from '@mmt/contracts';
import { siteComputersTextTemplates } from '../i18n/siteComputers';

const NAME_VALUE_SEPARATOR = '=';

/**
 * The variables of a site or a person from NAME=VALUE lines, one per line. Blank lines are
 * skipped, and spaces around the name and the value are dropped (a value may contain "=").
 */
export function parseSiteVariables(lines: string): Record<string, string> {
  const variables = new Map<string, string>();
  for (const line of lines.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    const separator = entry.indexOf(NAME_VALUE_SEPARATOR);
    const name = entry.slice(0, Math.max(separator, 0)).trim();
    if (separator < 0 || !SITE_VARIABLE_NAME_PATTERN.test(name))
      throw new Error(siteComputersTextTemplates.siteVariableLineError(entry));
    if (variables.has(name)) throw new Error(siteComputersTextTemplates.siteVariableDuplicate(name));
    variables.set(name, entry.slice(separator + 1).trim());
  }
  if (variables.size > MAX_SITE_VARIABLES)
    throw new Error(siteComputersTextTemplates.siteVariablesTooMany(MAX_SITE_VARIABLES));
  // fromEntries defines own properties, so even a name like __proto__ stays a plain entry.
  return Object.fromEntries(variables);
}

/** The variables as the form edits them: NAME=VALUE lines in the stored order. */
export function formatSiteVariables(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([name, value]) => `${name}${NAME_VALUE_SEPARATOR}${value}`)
    .join('\n');
}

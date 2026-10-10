import { MAX_JOB_SHELL_BYTES } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import { siteComputersTextTemplates } from '../i18n/siteComputers';

const BYTES_PER_MIB = 1024 ** 2;

/**
 * A job shell as the API stores it: the script itself, non-empty and at most MAX_JOB_SHELL_BYTES
 * of UTF-8. It is saved as written, so whitespace is never trimmed.
 */
export function parseJobShellContent(content: string): string {
  if (!content.trim()) throw new Error(text.jobShellRequired);
  if (new TextEncoder().encode(content).length > MAX_JOB_SHELL_BYTES)
    throw new Error(siteComputersTextTemplates.jobShellTooLarge(MAX_JOB_SHELL_BYTES / BYTES_PER_MIB));
  return content;
}

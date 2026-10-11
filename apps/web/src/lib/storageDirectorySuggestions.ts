import type { DirectorySuggestions } from '@mmt/contracts';
import type { FieldSuggestions } from '../types/form';
import { text, textTemplates } from '../i18n/catalog';

/**
 * The root directory field's candidates and its note. A path that does not exist yet is only
 * noted when nothing completes it either, so typing part of an existing name stays quiet.
 */
export function toDirectoryFieldSuggestions(directories: DirectorySuggestions): FieldSuggestions {
  return { items: directories.items, note: directoryNote(directories) };
}

function directoryNote({
  status,
  resolvedPath,
  items,
  truncated,
}: DirectorySuggestions): string | undefined {
  if (status === 'not_directory') return textTemplates.storageDirectoryNotDirectory(resolvedPath);
  if (status === 'unavailable') return textTemplates.storageDirectoryUnavailable(resolvedPath);
  if (status === 'missing' && items.length === 0)
    return textTemplates.storageDirectoryMissing(resolvedPath);
  if (truncated) return text.storageDirectoryTruncated;
  return undefined;
}

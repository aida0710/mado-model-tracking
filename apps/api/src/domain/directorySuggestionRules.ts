import path from 'node:path';

/** Where to look for directories that complete a typed path, and which names qualify. */
export interface DirectorySuggestionPlan {
  /** The typed path made absolute, as the filesystem backend resolves its rootPath. */
  resolvedPath: string;
  /** The directory whose children are the candidates. */
  listedDirectory: string;
  /** What a candidate's name starts with: the typed last segment, empty after a trailing "/". */
  namePrefix: string;
  /** Hidden names (starting with ".") only when the typed last segment starts with ".". */
  includesHidden: boolean;
}

/**
 * "/data/" lists the children of /data; "/data/ex" lists the children of /data that start with
 * "ex". A relative path is resolved from `workingDirectory`, like the filesystem backend does.
 */
export function planDirectorySuggestions(
  typedPath: string,
  workingDirectory: string,
): DirectorySuggestionPlan {
  const lastSeparator = typedPath.lastIndexOf('/');
  const namePrefix = typedPath.slice(lastSeparator + 1);
  return {
    resolvedPath: path.resolve(workingDirectory, typedPath),
    listedDirectory: path.resolve(workingDirectory, typedPath.slice(0, lastSeparator + 1)),
    namePrefix,
    includesHidden: namePrefix.startsWith('.'),
  };
}

export function isSuggestedName(name: string, plan: DirectorySuggestionPlan): boolean {
  return name.startsWith(plan.namePrefix) && (plan.includesHidden || !name.startsWith('.'));
}

/** Code point order, so the order does not depend on the server's locale. */
export function compareDirectoryNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

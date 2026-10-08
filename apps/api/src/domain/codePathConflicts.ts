export function hasAncestorPathConflict(paths: readonly string[]): boolean {
  const pathSet = new Set(paths);
  return paths.some((path) => {
    let separatorIndex = path.indexOf('/');
    while (separatorIndex !== -1) {
      if (pathSet.has(path.slice(0, separatorIndex))) return true;
      separatorIndex = path.indexOf('/', separatorIndex + 1);
    }
    return false;
  });
}

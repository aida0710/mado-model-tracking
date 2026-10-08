import type { CodeSource, RepositoryFiles } from '@mmt/contracts';
import type { CodeWorkspace, GitRepository } from '../types/codeWorkspace';
import type { FormValues } from '../types/form';
import { text } from '../i18n/catalog';

export function validateFilePath(path: string) {
  if (
    !path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\\\u0000-\u001f\u007f]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) throw new Error(text.invalidFilePath);
}

export function validateFilePaths(paths: string[]) {
  paths.forEach(validateFilePath);
  const uniquePaths = new Set(paths);
  if (uniquePaths.size !== paths.length) throw new Error(text.duplicateFilePath);
  for (const path of paths) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++)
      if (uniquePaths.has(segments.slice(0, depth).join('/'))) throw new Error(text.duplicateFilePath);
  }
}

export function validateGitRepository(repository: GitRepository) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(repository.commit))
    throw new Error(text.pinnedCommitError);
  if (/[\s\u0000-\u001f\u007f]/.test(repository.url)) throw new Error(text.gitUrlError);
  if (/^git@[\w.-]+:[^\s]+$/.test(repository.url)) return;
  try {
    const url = new URL(repository.url);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash ||
      (url.protocol === 'https:' && url.username) ||
      (url.protocol === 'ssh:' && url.username && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(url.username)) || !url.hostname)
      throw new Error(text.gitUrlError);
  } catch { throw new Error(text.gitUrlError); }
}

export function createCodeWorkspace(source?: CodeSource | null): CodeWorkspace {
  return {
    files: source && (source.kind === 'git' || source.kind === 'inline') ? { ...source.files } : {},
    baseFiles: {},
    deletedFiles: source?.kind === 'git' ? [...(source.deletedFiles ?? [])] : [],
    omittedPaths: [],
    loadedRepository: null,
  };
}

function getGitOverlay(workspace: CodeWorkspace) {
  const files = Object.fromEntries(
    Object.entries(workspace.files).filter(([path, content]) =>
      !Object.hasOwn(workspace.baseFiles, path) || workspace.baseFiles[path] !== content),
  );
  const deletedFiles = [...new Set([
    ...workspace.deletedFiles,
    ...Object.keys(workspace.baseFiles).filter((path) => !Object.hasOwn(workspace.files, path)),
  ])].filter((path) => !Object.hasOwn(workspace.files, path)).sort();
  return { files, deletedFiles };
}

export function buildGitOverlay(workspace: CodeWorkspace) {
  const overlay = getGitOverlay(workspace);
  validateFilePaths([...Object.keys(overlay.files), ...overlay.deletedFiles]);
  return overlay;
}

export function loadWorkspaceRepository({
  workspace, repository, response,
}: { workspace: CodeWorkspace; repository: GitRepository; response: RepositoryFiles }): CodeWorkspace {
  if (response.commit.toLowerCase() !== repository.commit.toLowerCase())
    throw new Error(text.invalidResponse);
  validateFilePaths([...Object.keys(response.files), ...response.omittedPaths]);
  const overlay = buildGitOverlay(workspace);
  if (Object.keys(overlay.files).some((path) => response.omittedPaths.includes(path)))
    throw new Error(text.cannotEditOmitted);
  const files = { ...response.files, ...overlay.files };
  overlay.deletedFiles.forEach((path) => delete files[path]);
  validateFilePaths([...Object.keys(files), ...response.omittedPaths.filter((path) => !overlay.deletedFiles.includes(path))]);
  return {
    files, baseFiles: { ...response.files }, deletedFiles: overlay.deletedFiles,
    omittedPaths: [...response.omittedPaths], loadedRepository: { ...repository },
  };
}

export function addWorkspaceFile(workspace: CodeWorkspace, path: string): CodeWorkspace {
  if (workspace.omittedPaths.includes(path)) throw new Error(text.cannotEditOmitted);
  validateFilePaths([...Object.keys(workspace.files), ...workspace.omittedPaths.filter((omitted) => !workspace.deletedFiles.includes(omitted)), path]);
  return { ...workspace, files: { ...workspace.files, [path]: '' },
    deletedFiles: workspace.deletedFiles.filter((deleted) => deleted !== path) };
}

export function restoreWorkspaceFile(workspace: CodeWorkspace, path: string, removedContent?: string): CodeWorkspace {
  const content = removedContent ?? workspace.baseFiles[path];
  const files = content === undefined ? workspace.files : { ...workspace.files, [path]: content };
  validateFilePaths([...Object.keys(files), ...workspace.omittedPaths]);
  return { ...workspace, files, deletedFiles: workspace.deletedFiles.filter((deleted) => deleted !== path) };
}

export function deleteWorkspaceFile(workspace: CodeWorkspace, path: string): CodeWorkspace {
  const files = { ...workspace.files };
  delete files[path];
  const isBaseFile = !workspace.loadedRepository || Object.hasOwn(workspace.baseFiles, path);
  return { ...workspace, files, deletedFiles: [...new Set([...workspace.deletedFiles, ...(isBaseFile ? [path] : [])])] };
}

export function buildWorkspaceSource(repository: GitRepository, workspace: CodeWorkspace): CodeSource {
  validateGitRepository(repository);
  if (workspace.loadedRepository && (
    workspace.loadedRepository.url !== repository.url ||
    workspace.loadedRepository.commit.toLowerCase() !== repository.commit.toLowerCase()
  )) throw new Error(text.repositoryReloadRequired);
  return { kind: 'git', ...repository, ...buildGitOverlay(workspace) };
}

export function getFileLanguage(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    py: 'python', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'shell', html: 'html', css: 'css',
    sql: 'sql', toml: 'ini', txt: 'plaintext',
  };
  return languages[extension ?? ''] ?? 'plaintext';
}

export function getWorkspaceSignature(values: FormValues, workspace: CodeWorkspace): string {
  const { artifactSearch: _artifactSearch, ...savedValues } = values;
  // Incomplete edits must remain trackable until save reports their validation error.
  const source = values.sourceKind === 'git' ? getGitOverlay(workspace) : { files: workspace.files, deletedFiles: [] };
  return JSON.stringify({ values: savedValues, files: Object.entries(source.files).sort(([left], [right]) => left.localeCompare(right)),
    deletedFiles: source.deletedFiles });
}

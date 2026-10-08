import { useEffect, useRef, useState } from 'react';
import type { CodeSource } from '@mmt/contracts';
import { repositoryApi } from '../api/repository';
import { addWorkspaceFile, createCodeWorkspace, deleteWorkspaceFile, loadWorkspaceRepository,
  restoreWorkspaceFile, validateGitRepository } from '../lib/codeWorkspace';
import type { CodeWorkspace, GitRepository } from '../types/codeWorkspace';
import { useMutation } from './useMutation';

export function useCodeWorkspace({ projectId, initialSource, repository }: {
  projectId: string; initialSource?: CodeSource | null; repository: GitRepository | null;
}) {
  const [workspace, setWorkspace] = useState(() => createCodeWorkspace(initialSource));
  const [selectedPath, setSelectedPath] = useState(() => Object.keys(workspace.files).sort()[0] ?? '');
  const [newPath, setNewPath] = useState('');
  const mutation = useMutation();
  const repositoryRequest = useRef<AbortController | null>(null);
  const removedFiles = useRef<Record<string, string>>({});
  const repositoryKey = repository ? `${repository.url}\n${repository.commit}` : '';
  useEffect(() => {
    return () => repositoryRequest.current?.abort();
  }, [repositoryKey]);
  const paths = Object.keys(workspace.files).sort();
  const activePath = Object.hasOwn(workspace.files, selectedPath) ? selectedPath : paths[0] ?? '';
  function replaceWorkspace(source?: CodeSource | null) {
    repositoryRequest.current?.abort();
    const next = createCodeWorkspace(source);
    removedFiles.current = {};
    setWorkspace(next);
    setSelectedPath(Object.keys(next.files).sort()[0] ?? '');
    mutation.clearError();
  }
  async function loadRepository() {
    if (!repository) return;
    return mutation.run(async () => {
      validateGitRepository(repository);
      const controller = new AbortController();
      repositoryRequest.current = controller;
      try {
        const response = await repositoryApi.files(projectId, repository, controller.signal);
        if (controller.signal.aborted) return;
        const next = loadWorkspaceRepository({ workspace, repository, response });
        setWorkspace(next);
      } finally { if (repositoryRequest.current === controller) repositoryRequest.current = null; }
    });
  }
  function addFile() {
    void mutation.run(async () => {
      const path = newPath.trim();
      setWorkspace(addWorkspaceFile(workspace, path));
      setSelectedPath(path);
      setNewPath('');
    });
  }
  function restoreFile(path: string) {
    void mutation.run(async () => setWorkspace(restoreWorkspaceFile(workspace, path, removedFiles.current[path])));
  }
  function deleteFile() {
    if (!activePath) return;
    removedFiles.current[activePath] = workspace.files[activePath]!;
    setWorkspace(deleteWorkspaceFile(workspace, activePath));
  }
  function updateFile(path: string, content: string) {
    setWorkspace((previous) => {
      if (!Object.hasOwn(previous.files, path) || previous.files[path] === content) return previous;
      return { ...previous, files: { ...previous.files, [path]: content } };
    });
  }
  return { ...mutation, workspace, setWorkspace, paths, activePath, selectPath: setSelectedPath,
    newPath, setNewPath, addFile, deleteFile,
    restoreFile, updateFile, replaceWorkspace, loadRepository };
}

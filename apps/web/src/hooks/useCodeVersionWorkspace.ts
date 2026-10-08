import { useRef, useState } from 'react';
import type { CodeVersion } from '@mmt/contracts';
import type { FormValues } from '../types/form';
import type { RepositoryMode } from '../types/codeWorkspace';
import type { CodeSample } from '../types/codeSample';
import { createValuesFromCodeVersion } from '../lib/codeVersionInput';
import { createCodeWorkspace, getWorkspaceSignature, validateFilePaths } from '../lib/codeWorkspace';
import { CODE_SAMPLES } from '../lib/codeSamples';
import { getFieldValue } from '../lib/formValues';
import { useCodeVersionForm } from './useCodeVersionForm';
import { useCodeWorkspace } from './useCodeWorkspace';
import { useUnsavedChanges } from './useUnsavedChanges';
import { text } from '../i18n/catalog';

export function useCodeVersionWorkspace({ projectId, codeId, initialVersion, versions, onNavigationDiscard }: {
  projectId: string; codeId: string; initialVersion?: CodeVersion; versions: CodeVersion[];
  onNavigationDiscard: () => void;
}) {
  const [baseVersion, setBaseVersion] = useState(initialVersion);
  const [sampleId, setSampleId] = useState<CodeSample['id']>('smoke');
  const [sampleError, setSampleError] = useState<string | null>(null);
  const form = useCodeVersionForm({ projectId, codeId, initialVersion });
  const sourceKind = getFieldValue(form.values, 'sourceKind');
  const editor = useCodeWorkspace({ projectId, initialSource: initialVersion?.source,
    repository: sourceKind === 'git' ? { url: getFieldValue(form.values, 'url').trim(), commit: getFieldValue(form.values, 'commit').trim() } : null });
  const initialSignature = useRef(getWorkspaceSignature(form.values, editor.workspace));
  const isDirty = initialSignature.current !== getWorkspaceSignature(form.values, editor.workspace);
  const busy = form.pending || editor.pending;
  const unsaved = useUnsavedChanges(isDirty, busy, { onNavigationDiscard });
  const baseRepository = baseVersion?.source?.kind === 'git' ? baseVersion.source : null;
  const repositoryMode: RepositoryMode = sourceKind === 'inline' ? 'standalone' :
    baseRepository?.url === getFieldValue(form.values, 'url').trim() ? 'same' : 'other';

  function changeValues(next: FormValues) {
    form.changeValues(next);
    setSampleError(null);
    if (next.sourceKind === 'inline' && sourceKind === 'git')
      editor.setWorkspace((previous) => ({ ...previous, baseFiles: {}, deletedFiles: [], omittedPaths: [], loadedRepository: null }));
  }
  function selectBaseVersion(id: string) {
    const selected = versions.find((version) => version.id === id);
    unsaved.requestAction(() => {
      const values = createValuesFromCodeVersion(selected);
      form.replaceValues(values);
      editor.replaceWorkspace(selected?.source);
      setBaseVersion(selected);
      setSampleError(null);
      initialSignature.current = getWorkspaceSignature(values, createCodeWorkspace(selected?.source));
    });
  }
  function changeRepositoryMode(mode: RepositoryMode) {
    const repository = mode === 'same' ? baseRepository : null;
    changeValues({ ...form.values, sourceKind: mode === 'standalone' ? 'inline' : 'git',
      url: repository?.url ?? '', commit: repository?.commit ?? '' });
  }
  function applySample() {
    setSampleError(null);
    const sample = CODE_SAMPLES.find((item) => item.id === sampleId)!;
    try {
      if (Object.keys(sample.files).some((path) => Object.hasOwn(editor.workspace.files, path)))
        throw new Error(text.sampleConflict);
      validateFilePaths([...Object.keys(editor.workspace.files), ...Object.keys(sample.files), ...editor.workspace.omittedPaths]);
      editor.setWorkspace((previous) => ({ ...previous, files: { ...previous.files, ...sample.files },
        deletedFiles: previous.deletedFiles.filter((path) => !Object.hasOwn(sample.files, path)) }));
      editor.selectPath('main.py');
      form.changeValues({ ...form.values, entrypoint: JSON.stringify(sample.entrypoint),
        testEntrypoint: JSON.stringify(sample.testEntrypoint), requirements: sample.requirements.join('\n'),
        families: sample.families.join('\n'), taskTypes: sample.taskTypes });
    } catch (error) { setSampleError(error instanceof Error ? error.message : String(error)); }
  }
  return { form, editor, sourceKind, baseVersion, sampleId, setSampleId, sampleError,
    isDirty, busy, unsaved, repositoryMode, changeValues, selectBaseVersion, changeRepositoryMode, applySample };
}

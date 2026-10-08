import { useState } from 'react';
import type { Artifact, CodeVersion } from '@mmt/contracts';
import { registryApi } from '../api/registry';
import {
  buildCodeVersionInput,
  createCodeVersionValues,
  updateCodeVersionValues,
} from '../lib/codeVersionInput';
import type { FormValues } from '../types/form';
import type { ArtifactUploadPurpose } from '../types/codeVersionForm';
import { getFieldValue } from '../lib/formValues';
import { useMutation } from './useMutation';
import { useProjectArtifacts } from './useProjectArtifacts';

export function useCodeVersionForm({ projectId, codeId }: { projectId: string; codeId: string }) {
  const [values, setValues] = useState(createCodeVersionValues);
  const [uploadPurpose, setUploadPurpose] = useState<ArtifactUploadPurpose | null>(null);
  const needsArtifacts =
    values.runtimeKind === 'singularity' ||
    values.runtimeKind === 'apptainer' ||
    values.sourceKind === 'artifact';
  const artifacts = useProjectArtifacts(
    projectId,
    needsArtifacts,
    getFieldValue(values, 'artifactSearch').trim(),
  );
  const mutation = useMutation();
  function changeValues(next: FormValues) {
    for (const fieldName of ['sifArtifactId', 'sourceArtifactId']) {
      if (next[fieldName] === values[fieldName]) continue;
      const selected = artifacts.items.find((artifact) => artifact.id === next[fieldName]);
      if (selected) artifacts.rememberArtifact(selected);
    }
    setValues((previous) =>
      updateCodeVersionValues({ previous, next, artifacts: artifacts.items }),
    );
    mutation.clearError();
  }
  function selectUploadedArtifact(artifact: Artifact) {
    if (!uploadPurpose) return;
    artifacts.rememberArtifact(artifact);
    setValues((previous) => ({
      ...previous,
      ...(uploadPurpose === 'sif'
        ? { sifArtifactId: artifact.id, sha256: artifact.sha256 }
        : { sourceArtifactId: artifact.id }),
    }));
    setUploadPurpose(null);
    mutation.clearError();
  }
  function save(): Promise<CodeVersion | undefined> {
    return mutation.run(() =>
      registryApi.createCodeVersion(
        projectId,
        codeId,
        buildCodeVersionInput({ values, artifacts: artifacts.items, projectId }),
      ),
    );
  }
  return {
    ...mutation,
    values,
    changeValues,
    selectUploadedArtifact,
    save,
    artifacts,
    needsArtifacts,
    uploadPurpose,
    openUpload: setUploadPurpose,
    closeUpload: () => setUploadPurpose(null),
  };
}

import { useEffect, useState } from 'react';
import type { Artifact, CodeVersion } from '@mmt/contracts';
import { registryApi } from '../api/registry';
import { trackingApi } from '../api/tracking';
import {
  buildCodeVersionInput,
  createValuesFromCodeVersion,
  updateCodeVersionValues,
} from '../lib/codeVersionInput';
import type { FormValues } from '../types/form';
import type { ArtifactUploadPurpose } from '../types/codeVersionForm';
import { getFieldValue } from '../lib/formValues';
import { useMutation } from './useMutation';
import { useProjectArtifacts } from './useProjectArtifacts';
import { useQuery } from './useQuery';
import type { CodeWorkspace } from '../types/codeWorkspace';

export function useCodeVersionForm({ projectId, codeId, initialVersion }: {
  projectId: string; codeId: string; initialVersion?: CodeVersion;
}) {
  const [values, setValues] = useState(() => createValuesFromCodeVersion(initialVersion));
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
  const sourceArtifactIds = [getFieldValue(values, 'sifArtifactId'), getFieldValue(values, 'sourceArtifactId')].filter(Boolean);
  const savedArtifacts = useQuery(needsArtifacts && sourceArtifactIds.length ? `${projectId}:code-artifacts:${sourceArtifactIds.join(',')}` : null,
    (signal) => Promise.all(sourceArtifactIds.map((id) => trackingApi.artifact(projectId, id, signal))));
  useEffect(() => {
    savedArtifacts.value?.forEach(artifacts.rememberArtifact);
  }, [savedArtifacts.value]);
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
  function save(workspace?: CodeWorkspace): Promise<CodeVersion | undefined> {
    return mutation.run(() =>
      registryApi.createCodeVersion(
        projectId,
        codeId,
        buildCodeVersionInput({ values, artifacts: artifacts.items, projectId, workspace }),
      ),
    );
  }
  return {
    ...mutation,
    values,
    changeValues,
    replaceValues: (next: FormValues) => { setValues(next); mutation.clearError(); },
    selectUploadedArtifact,
    save,
    artifacts,
    needsArtifacts,
    savedArtifacts,
    uploadPurpose,
    openUpload: setUploadPurpose,
    closeUpload: () => setUploadPurpose(null),
  };
}

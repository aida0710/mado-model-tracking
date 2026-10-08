import type { Artifact } from '@mmt/contracts';
import { FormFields } from './FormFields';
import type { FormField, FormValues } from '../types/form';
import type { ArtifactUploadPurpose } from '../types/codeVersionForm';
import { getFieldValue } from '../lib/formValues';
import { RUN_KINDS } from '../lib/executionValidation';
import { EXECUTION_RUNTIME_KINDS, isSifArtifact } from '../lib/runtimeValidation';
import { withEmptyOption } from '../lib/catalogOptions';
import { ARTIFACT_SEARCH_MAX_LENGTH } from '../lib/artifactCatalog';
import { runtimeLabels } from '../i18n/runtime';
import { text } from '../i18n/catalog';

export function CodeVersionFields({
  values,
  artifacts,
  onChange,
  onUpload,
}: {
  values: FormValues;
  artifacts: Artifact[];
  onChange: (values: FormValues) => void;
  onUpload: (purpose: ArtifactUploadPurpose) => void;
}) {
  const runtimeKind = getFieldValue(values, 'runtimeKind');
  const isContainer = runtimeKind !== 'python';
  const isSif = runtimeKind === 'singularity' || runtimeKind === 'apptainer';
  const sourceKind = getFieldValue(values, 'sourceKind');
  const artifactOptions = artifacts.map((artifact) => ({
    value: artifact.id,
    label: `${artifact.path} · ${artifact.id}`,
  }));
  const runtimeFields: FormField[] = [
    { name: 'version', label: text.version, required: true },
    {
      name: 'runtimeKind',
      label: text.runtime,
      type: 'select',
      required: true,
      options: EXECUTION_RUNTIME_KINDS.map((kind) => ({ value: kind, label: runtimeLabels[kind] })),
    },
    {
      name: 'image',
      label: text.dockerImage,
      required: true,
      placeholder: text.dockerImagePlaceholder,
      visible: () => runtimeKind === 'docker',
    },
    {
      name: 'artifactSearch',
      label: text.artifactSearch,
      placeholder: text.artifactSearchPlaceholder,
      maxLength: ARTIFACT_SEARCH_MAX_LENGTH,
      visible: () => isSif || sourceKind === 'artifact',
    },
    {
      name: 'sifArtifactId',
      label: text.sifArtifact,
      type: 'select',
      required: true,
      options: withEmptyOption(
        artifacts.filter(isSifArtifact).map((artifact) => ({
          value: artifact.id,
          label: `${artifact.path} · ${artifact.id}`,
        })),
      ),
      visible: () => isSif,
    },
    { name: 'sha256', label: text.sha256, readOnly: true, visible: () => isSif },
    {
      name: 'workingDirectory',
      label: text.containerWorkingDirectory,
      placeholder: text.workingDirectoryPlaceholder,
      visible: () => isContainer,
    },
  ];
  const sourceFields: FormField[] = [
    {
      name: 'sourceKind',
      label: text.sourceKind,
      type: 'select',
      required: true,
      options: [
        ...(isContainer ? [{ value: 'none', label: text.imageSource }] : []),
        { value: 'git', label: text.gitSource },
        { value: 'inline', label: text.inlineSource },
        { value: 'artifact', label: text.artifactSource },
      ],
    },
    { name: 'url', label: text.gitUrl, required: true, visible: () => sourceKind === 'git' },
    { name: 'commit', label: text.commit, required: true, visible: () => sourceKind === 'git' },
    {
      name: 'files',
      label: text.inlineFiles,
      type: 'textarea',
      required: true,
      visible: () => sourceKind === 'inline',
    },
    {
      name: 'sourceArtifactId',
      label: text.artifactId,
      type: 'select',
      required: true,
      options: withEmptyOption(artifactOptions),
      visible: () => sourceKind === 'artifact',
    },
  ];
  const commandFields: FormField[] = [
    {
      name: 'entrypoint',
      label: text.entrypoint,
      type: 'textarea',
      required: true,
      placeholder: text.entrypointPlaceholder,
    },
    {
      name: 'requirements',
      label: text.requirements,
      type: 'textarea',
      visible: () => !isContainer,
    },
    { name: 'environment', label: text.codeEnvironment, type: 'textarea' },
    { name: 'families', label: text.supportedFamilies, type: 'textarea', required: true },
    {
      name: 'taskTypes',
      label: text.taskTypes,
      type: 'multiselect',
      required: true,
      options: RUN_KINDS.map((kind) => ({ value: kind, label: text[kind] })),
    },
  ];
  return (
    <>
      <FormFields fields={runtimeFields} values={values} onChange={onChange} />
      {isSif && (
        <button type="button" className="button small field-action" onClick={() => onUpload('sif')}>
          {text.uploadArtifact}
        </button>
      )}
      <FormFields fields={sourceFields} values={values} onChange={onChange} />
      {sourceKind === 'artifact' && (
        <button
          type="button"
          className="button small field-action"
          onClick={() => onUpload('source')}
        >
          {text.uploadArtifact}
        </button>
      )}
      <FormFields fields={commandFields} values={values} onChange={onChange} />
    </>
  );
}

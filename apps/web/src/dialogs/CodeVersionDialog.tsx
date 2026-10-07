import type { Code, CodeSource, CodeVersion, RunKind } from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { registryApi } from '../api/registry';
import { FormDialog } from '../components/FormDialog';
import {
  getFieldValue,
  splitLines,
  getSelectedValues,
  parseStringArray,
  parseStringMap,
} from '../lib/formValues';
import { RUN_KINDS } from '../lib/executionValidation';
import { text } from '../i18n/catalog';

export function CodeVersionDialog({
  code,
  onClose,
  onSaved,
}: {
  code: Code;
  onClose: () => void;
  onSaved: (version: CodeVersion) => void;
}) {
  const { project } = useProject();
  return (
    <FormDialog
      title={`${code.name} · ${text.newVersion}`}
      onClose={onClose}
      onSaved={onSaved}
      fields={[
        { name: 'version', label: text.version, required: true },
        {
          name: 'sourceKind',
          label: text.sourceKind,
          type: 'select',
          required: true,
          defaultValue: 'git',
          options: [
            { value: 'git', label: text.gitSource },
            { value: 'inline', label: text.inlineSource },
            { value: 'artifact', label: text.artifactSource },
          ],
        },
        {
          name: 'url',
          label: text.gitUrl,
          required: true,
          visible: (values) => getFieldValue(values, 'sourceKind') === 'git',
        },
        {
          name: 'commit',
          label: text.commit,
          required: true,
          visible: (values) => getFieldValue(values, 'sourceKind') === 'git',
        },
        {
          name: 'files',
          label: text.inlineFiles,
          type: 'textarea',
          defaultValue: '{}',
          required: true,
          visible: (values) => getFieldValue(values, 'sourceKind') === 'inline',
        },
        {
          name: 'artifactId',
          label: text.artifactId,
          required: true,
          visible: (values) => getFieldValue(values, 'sourceKind') === 'artifact',
        },
        {
          name: 'entrypoint',
          label: text.entrypoint,
          type: 'textarea',
          required: true,
          placeholder: '["python", "main.py"]',
        },
        { name: 'requirements', label: text.requirements, type: 'textarea' },
        { name: 'environment', label: text.codeEnvironment, type: 'textarea', defaultValue: '{}' },
        { name: 'families', label: text.supportedFamilies, type: 'textarea', required: true },
        {
          name: 'taskTypes',
          label: text.taskTypes,
          type: 'multiselect',
          required: true,
          options: RUN_KINDS.map((kind) => ({ value: kind, label: text[kind] })),
        },
      ]}
      onSubmit={(values) => {
        const sourceKind = getFieldValue(values, 'sourceKind');
        const source: CodeSource =
          sourceKind === 'git'
            ? {
                kind: 'git',
                url: getFieldValue(values, 'url'),
                commit: getFieldValue(values, 'commit'),
              }
            : sourceKind === 'inline'
              ? { kind: 'inline', files: parseStringMap(getFieldValue(values, 'files')) }
              : { kind: 'artifact', artifactId: getFieldValue(values, 'artifactId') };
        return registryApi.createCodeVersion(project.id, code.id, {
          version: getFieldValue(values, 'version'),
          source,
          entrypoint: parseStringArray(getFieldValue(values, 'entrypoint')),
          requirements: splitLines(getFieldValue(values, 'requirements')),
          environment: parseStringMap(getFieldValue(values, 'environment')),
          supportedModelFamilies: splitLines(getFieldValue(values, 'families')),
          taskTypes: getSelectedValues(values, 'taskTypes') as RunKind[],
        });
      }}
    />
  );
}

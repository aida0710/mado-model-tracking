import type { ComputeTarget, RunKind } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormField, FormValues } from '../types/form';
import { getFieldValue } from '../lib/formValues';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import { isCodeCompatible, RUN_KINDS } from '../lib/executionValidation';
import { isTargetCompatible } from '../lib/runtimeValidation';
import { FormFields } from './FormFields';
import { text } from '../i18n/catalog';

export function TaskFields({ values, catalog, targets, onChange, isEditing = false, launchOnly = false }: {
  values: FormValues; catalog: ExecutionCatalog; targets: ComputeTarget[];
  onChange: (values: FormValues) => void; isEditing?: boolean; launchOnly?: boolean;
}) {
  const options = buildCatalogOptions(catalog);
  const kind = getFieldValue(values, 'kind') as RunKind;
  const model = catalog.modelVersions.find((item) => item.id === values.modelVersionId);
  const code = catalog.codeVersions.find((item) => item.id === values.codeVersionId);
  const target = targets.find((item) => item.id === values.targetId);
  const compatibleCodes = catalog.codeVersions.filter((item) => isCodeCompatible(item, kind, model));
  const fields: FormField[] = [
    { name: 'name', label: launchOnly ? text.runName : text.name, required: true },
    { name: 'description', label: text.description, type: 'textarea', visible: () => !launchOnly },
    { name: 'experimentId', label: text.experiments, type: 'select', required: true,
      options: withEmptyOption(options.experiments), visible: () => !isEditing && !launchOnly },
    { name: 'kind', label: text.kind, type: 'select', required: true,
      options: RUN_KINDS.map((value) => ({ value, label: text[value] })), visible: () => !launchOnly },
    { name: 'modelVersionId', label: text.modelVersion, type: 'select', options: withEmptyOption(options.models) },
    { name: 'codeVersionId', label: text.codeVersion, type: 'select', required: true,
      options: withEmptyOption(options.codes.filter((option) => compatibleCodes.some((item) => item.id === option.value))),
      visible: () => !launchOnly },
    { name: 'inputDatasetVersionIds', label: text.inputDatasets, type: 'multiselect', options: options.datasets },
    { name: 'targetId', label: text.target, type: 'select', required: launchOnly,
      options: withEmptyOption(targets.filter((item) => code && isTargetCompatible(item, code)).map((item) => ({ value: item.id, label: item.name }))) },
    { name: 'gpuIds', label: text.gpuIds, type: 'multiselect',
      options: target?.gpuIds.map((id) => ({ value: id, label: id })) ?? [] },
    { name: 'parameters', label: launchOnly ? text.taskParameterOverrides : text.parametersJson, type: 'textarea' },
    { name: 'tags', label: text.tagsJson, type: 'textarea', visible: () => !launchOnly },
  ];
  return <FormFields fields={fields} values={values} onChange={onChange} />;
}

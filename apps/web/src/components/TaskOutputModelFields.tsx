import type { CodeVersion } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormField, FormValues } from '../types/form';
import { getFieldValue } from '../lib/formValues';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import {
  getDefaultCodeCandidates, getOutputModelCandidates, getOutputModelFamilies, getOutputModelFamily,
} from '../lib/taskInput';
import { FormFields } from './FormFields';
import { text } from '../i18n/catalog';

const isEnabled = (values: FormValues) => getFieldValue(values, 'outputModelEnabled') === 'true';
const isCreating = (values: FormValues) => getFieldValue(values, 'outputModelTarget') === 'create';

export function TaskOutputModelFields({ values, catalog, code, onChange }: {
  values: FormValues; catalog: ExecutionCatalog; code: CodeVersion | undefined;
  onChange: (values: FormValues) => void;
}) {
  const models = getOutputModelCandidates(catalog.models, code);
  const family = getOutputModelFamily(values, catalog.models);
  const codeOptions = buildCatalogOptions({ ...catalog, codeVersions: getDefaultCodeCandidates(catalog.codeVersions, family) }).codes;
  const fields: FormField[] = [
    { name: 'outputModelEnabled', label: text.outputModelEnabled, type: 'checkbox' },
    { name: 'outputModelTarget', label: text.outputModelTarget, type: 'select', visible: isEnabled,
      options: [{ value: 'existing', label: text.outputModelExisting }, { value: 'create', label: text.outputModelCreate }] },
    { name: 'outputModelId', label: text.outputModelModel, type: 'select', required: true,
      options: withEmptyOption(models.map((model) => ({ value: model.id, label: `${model.name} · ${model.family}` }))),
      visible: (current) => isEnabled(current) && !isCreating(current) },
    { name: 'outputModelName', label: text.outputModelName, required: true,
      visible: (current) => isEnabled(current) && isCreating(current) },
    { name: 'outputModelFamily', label: text.family, type: 'select', required: true,
      options: withEmptyOption(getOutputModelFamilies(code).map((value) => ({ value, label: value }))),
      visible: (current) => isEnabled(current) && isCreating(current) },
    { name: 'outputModelArtifactPath', label: text.outputModelArtifactPath, required: true, visible: isEnabled },
    { name: 'outputModelDefaultCodeVersionId', label: text.outputModelDefaultCode, type: 'select',
      options: withEmptyOption(codeOptions), visible: isEnabled },
  ];
  return <fieldset className="task-output-model" data-testid="task-output-model">
    <legend>{text.outputModelSettings}</legend>
    <FormFields fields={fields} values={values} onChange={onChange} />
  </fieldset>;
}

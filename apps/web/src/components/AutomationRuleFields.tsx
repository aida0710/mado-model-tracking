import type { AutomationCatalog, AutomationKind } from '../types/modelAutomation';
import type { FormField, FormValues } from '../types/form';
import { FormFields } from './FormFields';
import { CodeRuntimeDetails } from './CodeRuntimeDetails';
import { getFieldValue, getSelectedValues } from '../lib/formValues';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import {
  AUTOMATION_KINDS,
  AUTOMATION_TRIGGERS,
  isAutomationCodeCompatible,
  upstreamRuleCandidates,
} from '../lib/modelAutomationInput';
import { MAX_JOB_ATTEMPTS } from '../lib/executionValidation';
import { isTargetCompatible } from '../lib/runtimeValidation';
import { text } from '../i18n/catalog';
import { automationText, automationTriggerLabels } from '../i18n/automation';

export function AutomationRuleFields({
  values,
  catalog,
  onChange,
}: {
  values: FormValues;
  catalog: AutomationCatalog;
  onChange: (values: FormValues) => void;
}) {
  const choices = catalog.registry;
  const options = buildCatalogOptions(choices);
  const modelFamilies = getSelectedValues(values, 'modelFamilies');
  const kind = getFieldValue(values, 'kind') as AutomationKind;
  const compatibleCodes = choices.codeVersions.filter((code) =>
    isAutomationCodeCompatible({ code, kind, modelFamilies }),
  );
  const code = compatibleCodes.find(
    (version) => version.id === getFieldValue(values, 'codeVersionId'),
  );
  const compatibleTargets = catalog.targets.filter(
    (target) => code && isTargetCompatible(target, code),
  );
  const target = compatibleTargets.find((item) => item.id === getFieldValue(values, 'targetId'));
  const families = [
    ...new Set([
      ...choices.models.map((model) => model.family),
      ...choices.codeVersions.flatMap((version) => version.supportedModelFamilies),
    ]),
  ].sort();
  const fields: FormField[] = [
    { name: 'name', label: text.name, required: true },
    {
      name: 'trigger',
      label: automationText.trigger,
      type: 'select',
      required: true,
      options: AUTOMATION_TRIGGERS.map((item) => ({
        value: item,
        label: automationTriggerLabels[item],
      })),
    },
    {
      name: 'upstreamRuleId',
      label: automationText.upstreamRule,
      type: 'select',
      required: true,
      visible: (current) => getFieldValue(current, 'trigger') === 'upstream_run_finished',
      options: withEmptyOption(
        upstreamRuleCandidates(catalog.rules).map((rule) => ({
          value: rule.id,
          label: `${rule.name} · ${text[rule.kind]}`,
        })),
      ),
    },
    {
      name: 'modelFamilies',
      label: text.automationModelFamilies,
      type: 'multiselect',
      required: true,
      options: families.map((family) => ({ value: family, label: family })),
    },
    {
      name: 'kind',
      label: text.kind,
      type: 'select',
      required: true,
      options: AUTOMATION_KINDS.map((item) => ({ value: item, label: text[item] })),
    },
    {
      name: 'experimentId',
      label: text.experiments,
      type: 'select',
      required: true,
      options: withEmptyOption(options.experiments),
    },
    {
      name: 'codeVersionId',
      label: text.codeVersion,
      type: 'select',
      required: true,
      options: withEmptyOption(
        options.codes.filter((option) =>
          compatibleCodes.some((version) => version.id === option.value),
        ),
      ),
    },
    {
      name: 'targetId',
      label: text.target,
      type: 'select',
      required: true,
      options: withEmptyOption(
        compatibleTargets.map((item) => ({ value: item.id, label: `${item.name} · ${item.host}` })),
      ),
    },
    {
      name: 'gpuIds',
      label: `${text.gpuIds} · ${text.cpuOnly}`,
      type: 'multiselect',
      options: (target?.gpuIds ?? []).map((id) => ({ value: id, label: id })),
    },
    {
      name: 'inputDatasetVersionIds',
      label: text.inputDatasets,
      type: 'multiselect',
      options: options.datasets,
    },
    { name: 'parameters', label: text.parametersJson, type: 'textarea' },
    { name: 'tags', label: text.tagsJson, type: 'textarea' },
    {
      name: 'maxAttempts',
      label: text.maxAttempts,
      type: 'number',
      required: true,
      min: 1,
      max: MAX_JOB_ATTEMPTS,
    },
    { name: 'enabled', label: text.enabled, type: 'checkbox' },
  ];
  return (
    <>
      <FormFields fields={fields} values={values} onChange={onChange} />
      {code && <CodeRuntimeDetails version={code} />}
      {code && !compatibleTargets.length && <p className="notice">{text.noCompatibleTargets}</p>}
    </>
  );
}

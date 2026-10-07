import type { Run, RunKind } from '@mmt/contracts';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { useProject } from '../hooks/useProject';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import {
  getFieldValue,
  parseJsonObject,
  getOptionalValue,
  getSelectedValues,
  parseStringMap,
} from '../lib/formValues';
import { RUN_KINDS, validateCodeCompatibility } from '../lib/executionValidation';
import { trackingApi } from '../api/tracking';
import { text } from '../i18n/catalog';

export function RunDialog({
  experimentId,
  onClose,
  onSaved,
}: {
  experimentId?: string;
  onClose: () => void;
  onSaved: (run: Run) => void;
}) {
  const { project } = useProject();
  const catalog = useExecutionCatalog(project.id);
  return (
    <QueryDialog title={text.newRun} onClose={onClose} query={catalog}>
      {(choices) => {
        const options = buildCatalogOptions(choices);
        return (
          <FormDialog
            title={text.newRun}
            onClose={onClose}
            onSaved={onSaved}
            submitLabel={text.create}
            fields={[
              { name: 'name', label: text.name, required: true },
              {
                name: 'experimentId',
                label: text.experiments,
                type: 'select',
                required: true,
                defaultValue: experimentId ?? '',
                options: withEmptyOption(options.experiments),
              },
              {
                name: 'kind',
                label: text.kind,
                type: 'select',
                required: true,
                defaultValue: 'inference',
                options: RUN_KINDS.map((kind) => ({ value: kind, label: text[kind] })),
              },
              {
                name: 'modelVersionId',
                label: text.modelVersion,
                type: 'select',
                options: withEmptyOption(options.models),
              },
              {
                name: 'codeVersionId',
                label: text.codeVersion,
                type: 'select',
                options: withEmptyOption(options.codes),
              },
              {
                name: 'inputDatasetVersionIds',
                label: text.inputDatasets,
                type: 'multiselect',
                options: options.datasets,
              },
              {
                name: 'parentRunId',
                label: text.parentRun,
                type: 'select',
                options: withEmptyOption(options.runs),
              },
              {
                name: 'parameters',
                label: `${text.parameters} (JSON)`,
                type: 'textarea',
                defaultValue: '{}',
              },
              { name: 'tags', label: `${text.tags} (JSON)`, type: 'textarea', defaultValue: '{}' },
              {
                name: 'environment',
                label: `${text.environment} (JSON)`,
                type: 'textarea',
                defaultValue: '{}',
              },
            ]}
            onSubmit={(values) => {
              const kind = getFieldValue(values, 'kind') as RunKind;
              validateCodeCompatibility(
                choices.codeVersions.find(
                  (code) => code.id === getFieldValue(values, 'codeVersionId'),
                ),
                kind,
                choices.modelVersions.find(
                  (model) => model.id === getFieldValue(values, 'modelVersionId'),
                ),
              );
              return trackingApi.createRun(project.id, {
                name: getFieldValue(values, 'name'),
                experimentId: getFieldValue(values, 'experimentId'),
                kind,
                modelVersionId: getOptionalValue(values, 'modelVersionId'),
                codeVersionId: getOptionalValue(values, 'codeVersionId'),
                inputDatasetVersionIds: getSelectedValues(values, 'inputDatasetVersionIds'),
                parentRunId: getOptionalValue(values, 'parentRunId'),
                parameters: parseJsonObject(getFieldValue(values, 'parameters')),
                tags: parseStringMap(getFieldValue(values, 'tags')),
                environment: parseJsonObject(getFieldValue(values, 'environment')),
              });
            }}
          />
        );
      }}
    </QueryDialog>
  );
}

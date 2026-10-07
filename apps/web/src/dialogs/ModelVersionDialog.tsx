import type { Model, ModelVersion } from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { registryApi } from '../api/registry';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import {
  getFieldValue,
  parseJsonObject,
  getOptionalValue,
  getSelectedValues,
} from '../lib/formValues';
import { text } from '../i18n/catalog';

export function ModelVersionDialog({
  model,
  onClose,
  onSaved,
}: {
  model: Model;
  onClose: () => void;
  onSaved: (version: ModelVersion) => void;
}) {
  const { project } = useProject();
  const catalog = useExecutionCatalog(project.id);
  return (
    <QueryDialog title={`${model.name} · ${text.newVersion}`} onClose={onClose} query={catalog}>
      {(choices) => {
        const options = buildCatalogOptions(choices);
        return (
          <FormDialog
            title={`${model.name} · ${text.newVersion}`}
            onClose={onClose}
            onSaved={onSaved}
            fields={[
              { name: 'version', label: text.version, required: true },
              {
                name: 'parents',
                label: text.parents,
                type: 'multiselect',
                options: options.models.filter(
                  (option) =>
                    choices.modelVersions.find((version) => version.id === option.value)?.family ===
                    model.family,
                ),
              },
              {
                name: 'sourceRunId',
                label: text.sourceRun,
                type: 'select',
                options: withEmptyOption(options.runs),
              },
              { name: 'weightsUri', label: text.weightsUri },
              { name: 'artifactId', label: text.artifactId },
              {
                name: 'defaultCodeVersionId',
                label: text.defaultCode,
                type: 'select',
                options: withEmptyOption(
                  options.codes.filter((option) =>
                    choices.codeVersions
                      .find((version) => version.id === option.value)
                      ?.supportedModelFamilies.includes(model.family),
                  ),
                ),
              },
              { name: 'metadata', label: text.metadata, type: 'textarea', defaultValue: '{}' },
            ]}
            onSubmit={(values) =>
              registryApi.createModelVersion(project.id, model.id, {
                version: getFieldValue(values, 'version'),
                parentModelVersionIds: getSelectedValues(values, 'parents'),
                sourceRunId: getOptionalValue(values, 'sourceRunId'),
                weightsUri: getOptionalValue(values, 'weightsUri'),
                artifactId: getOptionalValue(values, 'artifactId'),
                defaultCodeVersionId: getOptionalValue(values, 'defaultCodeVersionId'),
                metadata: parseJsonObject(getFieldValue(values, 'metadata')),
              })
            }
          />
        );
      }}
    </QueryDialog>
  );
}

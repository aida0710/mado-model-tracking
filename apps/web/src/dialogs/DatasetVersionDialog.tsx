import type { Dataset, DatasetVersion } from '@mmt/contracts';
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

export function DatasetVersionDialog({
  dataset,
  onClose,
  onSaved,
}: {
  dataset: Dataset;
  onClose: () => void;
  onSaved: (version: DatasetVersion) => void;
}) {
  const { project } = useProject();
  const catalog = useExecutionCatalog(project.id);
  return (
    <QueryDialog title={`${dataset.name} · ${text.newVersion}`} onClose={onClose} query={catalog}>
      {(choices) => {
        const options = buildCatalogOptions(choices);
        return (
          <FormDialog
            title={`${dataset.name} · ${text.newVersion}`}
            onClose={onClose}
            onSaved={onSaved}
            fields={[
              { name: 'version', label: text.version, required: true },
              { name: 'uri', label: text.uri, required: true },
              { name: 'digest', label: text.digest, required: true },
              {
                name: 'parents',
                label: text.parents,
                type: 'multiselect',
                options: options.datasets,
              },
              {
                name: 'sourceRunId',
                label: text.sourceRun,
                type: 'select',
                options: withEmptyOption(options.runs),
              },
              { name: 'schema', label: text.schema, type: 'textarea', defaultValue: '{}' },
              { name: 'metadata', label: text.metadata, type: 'textarea', defaultValue: '{}' },
            ]}
            onSubmit={(values) =>
              registryApi.createDatasetVersion(project.id, dataset.id, {
                version: getFieldValue(values, 'version'),
                uri: getFieldValue(values, 'uri'),
                digest: getFieldValue(values, 'digest'),
                parentDatasetVersionIds: getSelectedValues(values, 'parents'),
                sourceRunId: getOptionalValue(values, 'sourceRunId'),
                schema: parseJsonObject(getFieldValue(values, 'schema')),
                metadata: parseJsonObject(getFieldValue(values, 'metadata')),
              })
            }
          />
        );
      }}
    </QueryDialog>
  );
}

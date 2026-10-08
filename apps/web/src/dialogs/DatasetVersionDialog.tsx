import { useState, type DragEvent } from 'react';
import type { Dataset, DatasetVersion } from '@mmt/contracts';
import { FolderUp } from 'lucide-react';
import { useProject } from '../hooks/useProject';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { useDatasetFolderVersion } from '../hooks/useDatasetFolderVersion';
import { registryApi } from '../api/registry';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { FormFields } from '../components/FormFields';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { UploadQueuePanel } from '../components/UploadQueuePanel';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import { formatErrorMessage } from '../lib/errorMessage';
import { sourcesFromDataTransfer, sourcesFromFileList, type UploadSource } from '../lib/droppedFiles';
import { formatBytes } from '../lib/format';
import {
  createInitialValues,
  getFieldValue,
  parseJsonObject,
  getOptionalValue,
  getSelectedValues,
} from '../lib/formValues';
import type { FormField } from '../types/form';
import { text, textTemplates } from '../i18n/catalog';

/** 'reference' registers a uri and digest; 'folder' uploads a folder and lists its Artifacts. */
export type DatasetVersionSource = 'reference' | 'folder';

export function DatasetVersionDialog({
  dataset,
  source,
  onClose,
  onSaved,
}: {
  dataset: Dataset;
  source: DatasetVersionSource;
  onClose: () => void;
  onSaved: (version: DatasetVersion) => void;
}) {
  const { project } = useProject();
  const catalog = useExecutionCatalog(project.id);
  const title = `${dataset.name} · ${source === 'folder' ? text.datasetVersionFromFolder : text.newVersion}`;
  return (
    <QueryDialog title={title} onClose={onClose} query={catalog}>
      {(choices) => {
        const options = buildCatalogOptions(choices);
        return source === 'folder' ? (
          <FolderVersionDialog
            title={title}
            dataset={dataset}
            options={options}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <FormDialog
            title={title}
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

function FolderVersionDialog({
  title,
  dataset,
  options,
  onClose,
  onSaved,
}: {
  title: string;
  dataset: Dataset;
  options: ReturnType<typeof buildCatalogOptions>;
  onClose: () => void;
  onSaved: (version: DatasetVersion) => void;
}) {
  const { project } = useProject();
  const fields: FormField[] = [
    { name: 'version', label: text.datasetVersionOptional },
    { name: 'parents', label: text.parents, type: 'multiselect', options: options.datasets },
    { name: 'metadata', label: text.metadata, type: 'textarea', defaultValue: '{}' },
  ];
  const [values, setValues] = useState(() => createInitialValues(fields));
  const [sources, setSources] = useState<UploadSource[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const folder = useDatasetFolderVersion({ projectId: project.id, dataset, onCreated: onSaved });
  const { queue } = folder;
  const busy = queue.isActive || folder.isCreating;

  function start() {
    let metadata;
    try {
      metadata = parseJsonObject(getFieldValue(values, 'metadata'));
    } catch (failure) {
      setFormError(formatErrorMessage(failure));
      return;
    }
    setFormError(null);
    folder.start(sources, {
      version: getOptionalValue(values, 'version'),
      metadata,
      parentDatasetVersionIds: getSelectedValues(values, 'parents'),
    });
  }
  async function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragging(false);
    setSources(await sourcesFromDataTransfer(event.dataTransfer));
  }
  const totalSize = sources.reduce((total, chosen) => total + chosen.file.size, 0);
  return (
    <Dialog title={title} onClose={onClose} busy={busy} wide>
      <form
        className="artifact-upload-form touch-targets"
        onSubmit={(event) => {
          event.preventDefault();
          if (sources.length > 0 && !folder.hasStarted) start();
        }}
      >
        <fieldset disabled={folder.hasStarted}>
          <FormFields fields={fields} values={values} onChange={setValues} />
          <div
            className={isDragging ? 'upload-dropzone dragging' : 'upload-dropzone'}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => void drop(event)}
          >
            <p className="muted">{text.datasetFolderHint}</p>
            <div className="upload-pickers">
              <label className="button">
                <FolderUp size={15} />
                {text.datasetFolderChoose}
                <input
                  type="file"
                  className="sr-only"
                  // React has no typed prop for the non-standard folder picker attribute.
                  ref={(input) => input?.setAttribute('webkitdirectory', '')}
                  onChange={(event) => {
                    setSources(sourcesFromFileList(event.target.files));
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>
          {sources.length > 0 && (
            <p className="upload-selection">
              {textTemplates.datasetFolderSelected(sources.length, formatBytes(totalSize))}
            </p>
          )}
        </fieldset>
        <ErrorNotice message={formError} />
        <UploadQueuePanel
          items={queue.items}
          onPause={queue.pause}
          onResume={queue.resume}
          onCancel={(id) => void queue.cancel(id)}
          onRetryFailed={queue.retryFailed}
        />
        {queue.isActive && <p className="muted">{text.uploadInProgressNotice}</p>}
        {folder.isWaitingForChoice && (
          <div className="notice dataset-folder-choice" role="status">
            <p>{textTemplates.datasetFolderUnfinished(folder.unfinishedCount, folder.storedCount)}</p>
            <div className="upload-pickers">
              <button type="button" className="button small" onClick={folder.resendUnfinished}>
                {text.datasetFolderResendUnfinished}
              </button>
              <button
                type="button"
                className="button small primary"
                disabled={folder.storedCount === 0}
                onClick={folder.createWithoutUnfinished}
              >
                {text.datasetFolderCreateWithoutUnfinished}
              </button>
            </div>
          </div>
        )}
        {folder.isCreating && <p className="muted">{text.datasetFolderCreating}</p>}
        <ErrorNotice message={folder.creationError} />
        <footer>
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {text.close}
          </button>
          {folder.isUploaded && folder.creationError && (
            <button type="button" className="button primary" disabled={busy} onClick={folder.retryCreate}>
              {text.datasetFolderRetryCreate}
            </button>
          )}
          {!folder.hasStarted && (
            <button className="button primary" disabled={sources.length === 0}>
              {text.datasetFolderUploadAndCreate}
            </button>
          )}
        </footer>
      </form>
    </Dialog>
  );
}

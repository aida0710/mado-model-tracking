import { useEffect, useRef, useState } from 'react';
import type { Dataset, DatasetVersion, JsonObject } from '@mmt/contracts';
import { registryApi } from '../api/registry';
import { datasetFolderProgress, planDatasetFolder, type DatasetFolderEntry } from '../lib/datasetFolder';
import type { UploadSource } from '../lib/droppedFiles';
import { useArtifactUploadQueue } from './useArtifactUploadQueue';
import { useMutation } from './useMutation';

/** Version fields sent with the file list once every upload has finished. */
export interface DatasetFolderVersionFields {
  /** undefined takes the next integer version. */
  version?: string;
  metadata: JsonObject;
  parentDatasetVersionIds: string[];
}

/**
 * Uploads a folder as standalone Artifacts with the resumable queue, then creates an 'artifacts'
 * DatasetVersion from the completed Artifact IDs. Creation starts by itself once every file is
 * stored; a failed creation is retried by hand, the uploads are not repeated. Files that stopped
 * (failed, paused, or canceled) hold the version back until they are sent again or left out.
 */
export function useDatasetFolderVersion({
  projectId,
  dataset,
  onCreated,
}: {
  projectId: string;
  dataset: Dataset;
  onCreated: (version: DatasetVersion) => void;
}) {
  const queue = useArtifactUploadQueue({ projectId, runId: null, onCompleted: () => undefined });
  const creation = useMutation();
  const [entries, setEntries] = useState<DatasetFolderEntry[]>([]);
  const fieldsRef = useRef<DatasetFolderVersionFields | null>(null);
  const attemptedRef = useRef(false);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  const { storedArtifactIds, unfinishedItemIds, isUploaded } = datasetFolderProgress(entries, queue.items);
  const isWaitingForChoice = !queue.isActive && unfinishedItemIds.length > 0;

  function start(sources: UploadSource[], fields: DatasetFolderVersionFields) {
    // A timestamp keeps each upload in its own folder without needing crypto.randomUUID, which
    // browsers only offer on HTTPS origins.
    const uploadId = new Date().toISOString().replace(/[:.]/g, '-');
    const planned = planDatasetFolder(sources, { datasetId: dataset.id, uploadId });
    fieldsRef.current = fields;
    attemptedRef.current = false;
    setEntries(planned);
    queue.enqueue(planned.map((entry) => ({ source: entry.source, path: entry.artifactPath })));
  }

  async function create() {
    const fields = fieldsRef.current;
    if (!fields) return;
    attemptedRef.current = true;
    const version = await creation.run(() =>
      registryApi.createDatasetVersion(projectId, dataset.id, {
        ...fields,
        content: {
          kind: 'artifacts',
          files: entries.map((entry) => ({
            path: entry.datasetPath,
            artifactId: storedArtifactIds.get(entry.artifactPath)!,
          })),
        },
      }),
    );
    if (version) onCreatedRef.current(version);
  }

  /** Sends every stopped file again; canceled ones start from the beginning. */
  function resendUnfinished() {
    for (const id of unfinishedItemIds) queue.resume(id);
  }

  /** Creates the version from the stored files only; open sessions of the rest are discarded. */
  function createWithoutUnfinished() {
    for (const id of unfinishedItemIds) void queue.cancel(id);
    setEntries((previous) => previous.filter((entry) => storedArtifactIds.has(entry.artifactPath)));
  }

  useEffect(() => {
    if (isUploaded && !attemptedRef.current) void create();
    // create reads the latest entries and queue state; it runs once when the uploads finish.
  }, [isUploaded]);

  return {
    queue,
    hasStarted: entries.length > 0,
    isUploaded,
    /** Uploads stopped short of the whole folder; the dialog asks to resend or leave them out. */
    isWaitingForChoice,
    unfinishedCount: unfinishedItemIds.length,
    storedCount: storedArtifactIds.size,
    resendUnfinished,
    createWithoutUnfinished,
    isCreating: creation.pending,
    creationError: creation.error,
    retryCreate: () => void create(),
    start,
  };
}

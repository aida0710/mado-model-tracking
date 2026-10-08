import { useState, type DragEvent } from 'react';
import type { Artifact, ArtifactUpload } from '@mmt/contracts';
import { FolderUp, Trash2, Upload } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { UploadQueuePanel } from '../components/UploadQueuePanel';
import { useArtifactUploadQueue } from '../hooks/useArtifactUploadQueue';
import { useMutation } from '../hooks/useMutation';
import { sourcesFromDataTransfer, sourcesFromFileList, type UploadSource } from '../lib/droppedFiles';
import { formatBytes, formatDate } from '../lib/format';
import { joinArtifactPath } from '../lib/uploadPlan';
import { text, textTemplates } from '../i18n/catalog';

/**
 * Uploads Artifacts with progress, pause, cancel, and resume. `multiple` adds several files,
 * folders, and a destination folder; without it the dialog takes one file and closes on its
 * Artifact, as the code version form expects.
 */
export function ArtifactUploadDialog({
  projectId,
  runId,
  onClose,
  onSaved,
  accept,
  multiple = false,
}: {
  projectId: string;
  runId: string | null;
  onClose: () => void;
  /** Called once per completed Artifact. */
  onSaved: (artifact: Artifact) => void;
  accept?: string;
  multiple?: boolean;
}) {
  const [sources, setSources] = useState<UploadSource[]>([]);
  const [destination, setDestination] = useState('');
  const [singlePath, setSinglePath] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const queue = useArtifactUploadQueue({ projectId, runId, onCompleted: onSaved });

  function select(selected: UploadSource[]) {
    const accepted = multiple ? selected : selected.slice(0, 1);
    setSources(accepted);
    const first = accepted[0];
    setSinglePath(first ? first.relativePath : '');
  }
  async function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragging(false);
    select(await sourcesFromDataTransfer(event.dataTransfer));
  }
  function start() {
    const isSingle = sources.length === 1;
    queue.enqueue(
      sources.map((source) => ({
        source,
        path: isSingle ? joinArtifactPath('', singlePath) : joinArtifactPath(destination, source.relativePath),
      })),
    );
    setSources([]);
  }
  const totalSize = sources.reduce((total, source) => total + source.file.size, 0);
  const canStart = sources.length > 0 && (sources.length > 1 || joinArtifactPath('', singlePath) !== '');
  return (
    <Dialog title={text.uploadArtifact} onClose={onClose} busy={queue.isActive} wide>
      <form
        className="artifact-upload-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canStart) start();
        }}
      >
        <div
          className={isDragging ? 'upload-dropzone dragging' : 'upload-dropzone'}
          data-testid="upload-dropzone"
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => void drop(event)}
        >
          <p className="muted">{text.uploadDropHint}</p>
          <div className="upload-pickers">
            <label className="button">
              <Upload size={15} />
              {text.uploadChooseFiles}
              <input
                type="file"
                className="sr-only"
                accept={accept}
                multiple={multiple}
                onChange={(event) => {
                  select(sourcesFromFileList(event.target.files));
                  event.target.value = '';
                }}
              />
            </label>
            {multiple && (
              <label className="button">
                <FolderUp size={15} />
                {text.uploadChooseFolder}
                <input
                  type="file"
                  className="sr-only"
                  // React has no typed prop for the non-standard folder picker attribute.
                  ref={(input) => input?.setAttribute('webkitdirectory', '')}
                  onChange={(event) => {
                    select(sourcesFromFileList(event.target.files));
                    event.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        </div>
        {sources.length === 1 && (
          <label className="field">
            <span>{text.artifactPath}</span>
            <input required value={singlePath} onChange={(event) => setSinglePath(event.target.value)} />
          </label>
        )}
        {sources.length > 1 && (
          <>
            <p className="upload-selection">
              {text.uploadSelectedFiles}: {textTemplates.uploadSelectedCount(sources.length, formatBytes(totalSize))}
            </p>
            <label className="field">
              <span>{text.uploadDestination}</span>
              <input value={destination} onChange={(event) => setDestination(event.target.value)} />
              <small className="muted">{text.uploadDestinationHint}</small>
            </label>
          </>
        )}
        <ResumableSessions sessions={queue.resumableSessions} onDiscard={queue.discardSession} />
        <ErrorNotice message={queue.resumableSessionsError} />
        <UploadQueuePanel
          items={queue.items}
          onPause={queue.pause}
          onResume={queue.resume}
          onCancel={(id) => void queue.cancel(id)}
          onRetryFailed={queue.retryFailed}
        />
        {queue.isActive && <p className="muted">{text.uploadInProgressNotice}</p>}
        <footer>
          <button type="button" className="button" disabled={queue.isActive} onClick={onClose}>
            {text.close}
          </button>
          {sources.length > 0 && (
            <button type="button" className="button" onClick={() => select([])}>
              {text.uploadClearSelection}
            </button>
          )}
          <button className="button primary" disabled={!canStart}>
            {text.uploadStart}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function ResumableSessions({
  sessions,
  onDiscard,
}: {
  sessions: ArtifactUpload[];
  onDiscard: (uploadId: string) => Promise<void>;
}) {
  const mutation = useMutation();
  if (sessions.length === 0) return null;
  return (
    <section className="upload-resumable" aria-label={text.uploadResumableSessions}>
      <h3>{text.uploadResumableSessions}</h3>
      <p className="muted">{text.uploadResumableHint}</p>
      <ul>
        {sessions.map((session) => (
          <li key={session.id} data-testid="upload-resumable-session">
            <span className="mono">{session.path}</span>
            <span className="muted">{formatBytes(session.expectedSize)}</span>
            <span className="muted">{text.uploadExpires}: {formatDate(session.expiresAt)}</span>
            <button
              type="button"
              className="button small"
              disabled={mutation.pending}
              onClick={() => void mutation.run(() => onDiscard(session.id))}
            >
              <Trash2 size={14} />
              {text.uploadDiscardSession}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNotice message={mutation.error} />
    </section>
  );
}

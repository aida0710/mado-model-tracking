import { Pause, Play, RotateCcw, X } from 'lucide-react';
import type { UploadItem } from '../hooks/useArtifactUploadQueue';
import { CopyButton } from './CopyButton';
import { formatBytes } from '../lib/format';
import { text, textTemplates } from '../i18n/catalog';
import { uploadStatusLabels } from '../i18n/uploads';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

function formatRemaining(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  if (seconds < SECONDS_PER_HOUR) return `${minutes}m ${seconds % SECONDS_PER_MINUTE}s`;
  return `${Math.floor(seconds / SECONDS_PER_HOUR)}h ${minutes}m`;
}

export function UploadQueuePanel({
  items,
  onPause,
  onResume,
  onCancel,
  onRetryFailed,
}: {
  items: UploadItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetryFailed: () => void;
}) {
  if (items.length === 0) return null;
  const completedCount = items.filter((item) => item.status === 'completed').length;
  const hasFailed = items.some((item) => item.status === 'failed');
  return (
    <section className="upload-queue" aria-label={text.uploadQueue}>
      <header>
        <h3>{text.uploadQueue}</h3>
        <span className="muted">{textTemplates.uploadProgressSummary(completedCount, items.length)}</span>
        {hasFailed && (
          <button type="button" className="button small" onClick={onRetryFailed}>
            <RotateCcw size={14} />
            {text.uploadRetryFailed}
          </button>
        )}
      </header>
      <ul>
        {items.map((item) => (
          <UploadQueueRow key={item.id} item={item} onPause={onPause} onResume={onResume} onCancel={onCancel} />
        ))}
      </ul>
    </section>
  );
}

function UploadQueueRow({
  item,
  onPause,
  onResume,
  onCancel,
}: {
  item: UploadItem;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const canPause = item.method === 'multipart' && ['queued', 'preparing', 'uploading'].includes(item.status);
  const canResume = item.status === 'paused' || item.status === 'failed';
  const canCancel = !['verifying', 'completed', 'canceled'].includes(item.status);
  const percent = item.size === 0 ? (item.status === 'completed' ? 100 : 0) : (item.sentBytes / item.size) * 100;
  return (
    <li className={`upload-queue-row ${item.status}`} data-testid="upload-queue-row" data-status={item.status}>
      <div className="upload-queue-title">
        <span className="mono" title={item.path}>{item.path}</span>
        <span className={`upload-status ${item.status}`}>{uploadStatusLabels[item.status]}</span>
      </div>
      <progress max={100} value={percent} aria-label={item.path} />
      <div className="upload-queue-meta muted">
        <span>{formatBytes(item.sentBytes)} / {formatBytes(item.size)}</span>
        {item.bytesPerSecond !== null && (
          <span>{textTemplates.uploadTransferRate(formatBytes(item.bytesPerSecond))}</span>
        )}
        {item.remainingSeconds !== null && (
          <span>{textTemplates.uploadRemainingTime(formatRemaining(item.remainingSeconds))}</span>
        )}
        {item.resumedBytes > 0 && item.status !== 'completed' && (
          <span>{textTemplates.uploadResumedBytes(formatBytes(item.resumedBytes))}</span>
        )}
      </div>
      {item.error && <p className="upload-queue-error" role="alert">{item.error}</p>}
      {item.artifact && (
        <div className="upload-queue-artifact">
          <span className="mono">artifact://{item.artifact.id}</span>
          <CopyButton value={item.artifact.id} />
        </div>
      )}
      <div className="upload-queue-actions">
        {canPause && (
          <button type="button" className="button small" onClick={() => onPause(item.id)}>
            <Pause size={14} />
            {text.uploadPause}
          </button>
        )}
        {canResume && (
          <button type="button" className="button small" onClick={() => onResume(item.id)}>
            <Play size={14} />
            {text.uploadResume}
          </button>
        )}
        {canCancel && (
          <button type="button" className="button small" onClick={() => onCancel(item.id)}>
            <X size={14} />
            {text.uploadCancel}
          </button>
        )}
      </div>
    </li>
  );
}

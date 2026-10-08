import { useNavigate } from 'react-router-dom';
import type { JobRetryRequest, RunCheckpoint } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { useMutation } from '../hooks/useMutation';
import { text, textTemplates } from '../i18n/catalog';

/**
 * Confirms resuming training as a new Run by retrying the Job, then opens that Run.
 * Without `checkpoint` the API picks the retried Run's checkpoint with the largest step.
 */
export function ResumeDialog({
  projectId,
  jobId,
  checkpoint,
  onClose,
}: {
  projectId: string;
  jobId: string;
  checkpoint?: Pick<RunCheckpoint, 'id' | 'step'>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const mutation = useMutation();
  const retryRequest: JobRetryRequest = checkpoint
    ? { checkpointId: checkpoint.id }
    : { resumeFromLatestCheckpoint: true };
  return (
    <Dialog
      fullScreenOnNarrow
      title={checkpoint ? text.checkpointResumeTitle : text.checkpointResumeLatest}
      onClose={onClose}
      busy={mutation.pending}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run(() => executionApi.retryJob(projectId, jobId, retryRequest))
            .then((retried) => {
              if (retried) navigate(`/projects/${projectId}/runs/${retried.run.id}`);
            });
        }}
      >
        <p>
          {checkpoint
            ? textTemplates.checkpointResumeMessage(checkpoint.step)
            : text.checkpointResumeLatestMessage}
        </p>
        <p className="muted">{text.checkpointResumeKeepsSourceRun}</p>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending}>
            {mutation.pending ? text.loading : text.checkpointResumeSubmit}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

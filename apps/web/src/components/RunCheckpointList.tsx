import { useState } from 'react';
import type { Run, RunCheckpoint, RunCheckpointArtifact } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { DataTable } from './DataTable';
import { Resource } from './Feedback';
import { ResumeDialog } from '../dialogs/ResumeDialog';
import { useRunCheckpoints } from '../hooks/useRunCheckpoints';
import { useRunJob } from '../hooks/useRunJob';
import {
  canResumeFromCheckpoint,
  getCheckpointArtifactFileName,
  isResumableStatus,
} from '../lib/checkpointResume';
import { formatBytes, formatDate } from '../lib/format';
import { checkpointSourceLabels } from '../i18n/checkpoints';
import { text, textTemplates } from '../i18n/catalog';

/** A Run's checkpoints with their files, and resuming a stopped Run from one of them. */
export function RunCheckpointList({ run, canEdit }: { run: Run; canEdit: boolean }) {
  const [includeHidden, setIncludeHidden] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<RunCheckpoint | null>(null);
  const checkpoints = useRunCheckpoints({ projectId: run.projectId, runId: run.id, includeHidden });
  // Only an editor looking at a stopped Run can resume, so only then is the Run's Job looked up.
  const runJob = useRunJob({
    projectId: run.projectId,
    runId: run.id,
    enabled: canEdit && isResumableStatus(run.status),
  });
  const job = runJob.value ?? undefined;
  const canResume = canResumeFromCheckpoint({ run, job, canEdit });
  return (
    <section className="checkpoint-list">
      <label className="checkpoint-hidden-toggle">
        <input
          type="checkbox"
          checked={includeHidden}
          onChange={(event) => setIncludeHidden(event.target.checked)}
        />
        {text.checkpointShowHidden}
      </label>
      {runJob.value === null && <p className="muted">{text.checkpointResumeNoJob}</p>}
      <Resource query={checkpoints}>
        {(page) => (
          <DataTable
            items={page.items}
            rowKey={(checkpoint) => checkpoint.id}
            empty={text.checkpointEmpty}
            columns={[
              {
                key: 'step',
                label: text.step,
                render: (checkpoint) => (
                  <>
                    <span className="mono">{checkpoint.step}</span>
                    {!checkpoint.retained && (
                      <span
                        className="status-badge status-queued"
                        title={text.checkpointHiddenHint}
                      >
                        {text.checkpointHidden}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'created',
                label: text.created,
                render: (checkpoint) => formatDate(checkpoint.createdAt),
              },
              {
                key: 'size',
                label: text.size,
                className: 'mono',
                render: (checkpoint) => formatBytes(checkpoint.totalSize),
              },
              {
                key: 'source',
                label: text.source,
                render: (checkpoint) => checkpointSourceLabels[checkpoint.source],
              },
              {
                key: 'optimizer',
                label: text.checkpointOptimizer,
                render: (checkpoint) =>
                  checkpoint.manifest.includesOptimizer
                    ? text.checkpointIncludesOptimizer
                    : text.checkpointExcludesOptimizer,
              },
              {
                key: 'framework',
                label: text.checkpointFramework,
                render: (checkpoint) => checkpoint.manifest.framework ?? '—',
              },
              {
                key: 'artifacts',
                label: text.artifacts,
                render: (checkpoint) => (
                  <CheckpointArtifactLinks
                    projectId={run.projectId}
                    artifacts={checkpoint.artifacts}
                  />
                ),
              },
              ...(canResume
                ? [
                    {
                      key: 'resume',
                      label: text.checkpointResumeTitle,
                      render: (checkpoint: RunCheckpoint) => (
                        <button
                          className="button small"
                          onClick={() => setResumeTarget(checkpoint)}
                        >
                          {text.checkpointResume}
                        </button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Resource>
      {resumeTarget && job && (
        <ResumeDialog
          projectId={run.projectId}
          jobId={job.id}
          checkpoint={resumeTarget}
          onClose={() => setResumeTarget(null)}
        />
      )}
    </section>
  );
}

/** A native checkpoint is one tar; an MLflow one lists its files under a disclosure. */
function CheckpointArtifactLinks({
  projectId,
  artifacts,
}: {
  projectId: string;
  artifacts: RunCheckpointArtifact[];
}) {
  const links = artifacts.map((artifact) => (
    <a
      key={artifact.id}
      className="mono"
      href={trackingApi.artifactUrl(projectId, artifact.id)}
      download={getCheckpointArtifactFileName(artifact)}
    >
      {artifact.path}
    </a>
  ));
  if (links.length <= 1) return <>{links}</>;
  return (
    <details>
      <summary>{textTemplates.checkpointFileCount(links.length)}</summary>
      <ul className="checkpoint-artifacts">
        {links.map((link) => (
          <li key={link.key}>{link}</li>
        ))}
      </ul>
    </details>
  );
}

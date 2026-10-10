import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw } from 'lucide-react';
import { executionApi } from '../api/execution';
import { hooksApi } from '../api/hooks';
import { trackingApi } from '../api/tracking';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useProjectTargets } from '../hooks/useProjectTargets';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { Resource } from '../components/Feedback';
import { RunLogs } from '../components/RunLogs';
import { RunExecutionSnapshot } from '../components/RunExecutionSnapshot';
import { FormDialog } from '../components/FormDialog';
import { JobsTable, type JobAction } from '../components/JobsTable';
import { JobArraysTable } from '../components/JobArraysTable';
import { JobDetailsList } from '../components/JobDetailsList';
import { ManualSubmissionNotice, ManualSubmitCommand } from '../components/ManualSubmissionNotice';
import { LaunchDialog } from '../dialogs/LaunchDialog';
import { ResumeDialog } from '../dialogs/ResumeDialog';
import { useResumedRunIds } from '../hooks/useResumedRunIds';
import { summarizeJobArrays } from '../lib/jobArrays';
import { shortId } from '../lib/jobDisplay';
import { isWaitingManualSubmission, manualSubmissionGroups } from '../lib/manualSubmission';
import { text } from '../i18n/catalog';
import { jobsTextTemplates } from '../i18n/jobs';

const STATUS_FILTERS = ['queued', 'claimed', 'running', 'finished', 'failed', 'canceled'] as const;

export function JobsPage() {
  const { project, canEdit } = useProject();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('job') ?? '';
  const statusFilter = params.get('status') ?? '';
  const arrayFilter = params.get('array') ?? '';
  const [showLaunch, setShowLaunch] = useState(false);
  const [jobAction, setJobAction] = useState<{ id: string; type: JobAction } | null>(null);
  const jobs = useQuery(
    `${project.id}:jobs`,
    (signal) => executionApi.jobs(project.id, signal),
    EXECUTION_POLL_MS,
  );
  const targets = useProjectTargets(project.id);
  // Hook names for the origin column; without them the column shows the hook's id.
  const hooks = useQuery(`${project.id}:job-hooks`, (signal) => hooksApi.list(project.id, signal));
  const resumedRunIds = useResumedRunIds(project.id, jobs.value);
  const selected = jobs.value?.find((job) => job.id === selectedId);
  const selectedRun = useQuery(selected ? `${project.id}:job-run:${selected.runId}` : null,
    (signal) => trackingApi.run(project.id, selected!.runId, signal), EXECUTION_POLL_MS);
  const sourceArtifacts = useQuery(selected ? `${project.id}:job-artifacts:${selected.runId}` : null,
    (signal) => trackingApi.artifacts(project.id, selected!.runId, signal), EXECUTION_POLL_MS);
  const logs = useQuery(
    selected ? `${selected.runId}:logs` : null,
    (signal) => trackingApi.logs(project.id, selected!.runId, signal),
    EXECUTION_POLL_MS,
  );
  const targetItems = targets.value ?? [];
  const hookItems = hooks.value ?? [];
  const setParam = (name: string, value: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    });
  const selectJob = (jobId: string) => setParam('job', jobId);
  const selectArray = (arrayGroupId: string) => setParam('array', arrayGroupId);
  return (
    <section className="page jobs-page">
      <PageHeader
        title={text.jobs}
        eyebrow={project.name}
        actions={
          <>
            {canEdit && (
              <button className="button primary" onClick={() => setShowLaunch(true)}>
                <Play size={15} />
                {text.launch}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={jobs.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      {jobs.value && (
        <ManualSubmissionNotice groups={manualSubmissionGroups(jobs.value, targetItems)} />
      )}
      <label className="chart-selector">
        <span>{text.status}</span>
        <select
          aria-label={text.status}
          value={statusFilter}
          onChange={(event) => setParam('status', event.target.value)}
        >
          <option value="">{text.allStatus}</option>
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {text[status]}
            </option>
          ))}
        </select>
      </label>
      <Resource query={jobs}>
        {(items) => {
          const arrays = summarizeJobArrays(items);
          const rows = items.filter(
            (job) =>
              (!statusFilter || job.status === statusFilter) &&
              (!arrayFilter || job.arrayGroupId === arrayFilter),
          );
          return (
            <>
              {arrays.length > 0 && (
                <JobArraysTable
                  arrays={arrays}
                  targets={targetItems}
                  hooks={hookItems}
                  projectId={project.id}
                  selectedArrayId={arrayFilter}
                  onSelectArray={selectArray}
                  onSelectJob={selectJob}
                />
              )}
              {arrayFilter && (
                <p className="notice">
                  <span>{jobsTextTemplates.jobArrayFilter(shortId(arrayFilter))}</span>
                  <button className="button small" onClick={() => setParam('array', '')}>
                    {text.jobArrayShowAll}
                  </button>
                </p>
              )}
              <JobsTable
                jobs={rows}
                targets={targetItems}
                hooks={hookItems}
                projectId={project.id}
                selectedId={selectedId}
                canEdit={canEdit}
                resumedRunIds={resumedRunIds.value}
                onSelectJob={selectJob}
                onSelectArray={selectArray}
                onAction={(id, type) => setJobAction({ id, type })}
              />
            </>
          );
        }}
      </Resource>
      {selected && (
        <section className="job-detail">
          <h2>{selected.runName}</h2>
          <JobDetailsList
            job={selected}
            target={targetItems.find((target) => target.id === selected.targetId)}
            hooks={hookItems}
            projectId={project.id}
            onSelectJob={selectJob}
            onSelectArray={selectArray}
          />
          {isWaitingManualSubmission(selected) && (
            <div className="notice manual-submission">
              <p>
                {selectedRun.value?.createdBy === user.id
                  ? text.manualSubmissionOwnHint
                  : text.manualSubmissionHint}
              </p>
              <ManualSubmitCommand targetId={selected.targetId} />
            </div>
          )}
          <Resource query={selectedRun}>
            {(run) => (
              <Resource query={sourceArtifacts}>
                {(artifacts) => (
                  <RunExecutionSnapshot run={run} artifacts={artifacts} taskName={selected.taskName} />
                )}
              </Resource>
            )}
          </Resource>
          <h3>{text.logs}</h3>
          <Resource query={logs}>{(entries) => <RunLogs entries={entries} />}</Resource>
        </section>
      )}
      {showLaunch && (
        <LaunchDialog
          onClose={() => setShowLaunch(false)}
          onSaved={(job) => {
            setShowLaunch(false);
            jobs.reload();
            setParams({ job: job.id });
          }}
        />
      )}
      {jobAction?.type === 'resumeLatest' && (
        <ResumeDialog
          projectId={project.id}
          jobId={jobAction.id}
          onClose={() => setJobAction(null)}
        />
      )}
      {(jobAction?.type === 'cancel' || jobAction?.type === 'retry') && (
        <FormDialog
          title={jobAction.type === 'cancel' ? text.cancelJob : text.retryJob}
          onClose={() => setJobAction(null)}
          fields={[]}
          onSubmit={async () =>
            jobAction.type === 'cancel'
              ? { canceled: await executionApi.cancelJob(project.id, jobAction.id) }
              : executionApi.retryJob(project.id, jobAction.id, {})
          }
          onSaved={(saved) => {
            setJobAction(null);
            jobs.reload();
            if ('run' in saved) navigate(`/projects/${project.id}/runs/${saved.run.id}`);
          }}
        />
      )}
    </section>
  );
}

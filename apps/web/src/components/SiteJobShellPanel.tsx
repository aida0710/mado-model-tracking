import { useId, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { SiteJobShell, SiteJobShellSummary } from '@mmt/contracts';
import { siteComputersApi } from '../api/siteComputers';
import { useMutation } from '../hooks/useMutation';
import { useQuery } from '../hooks/useQuery';
import { ErrorNotice, Resource } from './Feedback';
import { JobShellEditor } from './JobShellEditor';
import { ResponsiveTable } from './ResponsiveTable';
import { formatBytes, formatDate } from '../lib/format';
import { JOB_SHELL_TEMPLATES, findJobShellTemplate } from '../lib/jobShellTemplates';
import { parseJobShellContent } from '../lib/jobShellContent';
import { shortSha256 } from '../lib/siteComputerDisplay';
import { text } from '../i18n/catalog';
import { jobShellTemplateLabels, siteComputersTextTemplates } from '../i18n/siteComputers';

/**
 * A site's job shell: the current version's content, the versions before it, and for its owner
 * and global administrators an editor that saves the next version. Versions never change, and
 * each Job keeps the version it was submitted with.
 */
export function SiteJobShellPanel({
  targetId,
  canEdit,
  onSaved,
}: {
  targetId: string;
  canEdit: boolean;
  /** A new version became the current one. */
  onSaved: () => void;
}) {
  const versions = useQuery(`site-job-shells:${targetId}`, (signal) =>
    siteComputersApi.jobShells(targetId, signal),
  );
  const [shownId, setShownId] = useState<string | null>(null);
  const [isEditing, setEditing] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  // The API lists versions newest first, and the newest one is what later submissions use.
  const current = versions.value?.[0];
  const finishEditing = (saved: SiteJobShell) => {
    setEditing(false);
    setShownId(null);
    setSavedNotice(
      saved.id === current?.id
        ? text.jobShellUnchanged
        : siteComputersTextTemplates.jobShellSaved(saved.version),
    );
    versions.reload();
    onSaved();
  };
  return (
    <section className="site-computer-section" aria-label={text.jobShellSection}>
      <div className="section-heading">
        <h3>{text.jobShellSection}</h3>
        {canEdit && !isEditing && versions.value && (
          <button
            className="button small"
            onClick={() => {
              setSavedNotice(null);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
            {text.jobShellEdit}
          </button>
        )}
      </div>
      {savedNotice && (
        <p className="notice success" role="status">
          {savedNotice}
        </p>
      )}
      <Resource query={versions}>
        {(items) => {
          const shown = items.find((item) => item.id === shownId) ?? current;
          return (
            <>
              {isEditing ? (
                <JobShellEditForm
                  targetId={targetId}
                  currentId={current?.id ?? null}
                  onSaved={finishEditing}
                  onCancel={() => setEditing(false)}
                />
              ) : shown ? (
                <JobShellContent
                  targetId={targetId}
                  summary={shown}
                  isCurrent={shown.id === current?.id}
                  onShowCurrent={() => setShownId(null)}
                />
              ) : (
                <p className="notice">{text.jobShellNone}</p>
              )}
              {items.length > 0 && (
                <JobShellHistory
                  versions={items}
                  currentId={current?.id ?? null}
                  shownId={shown?.id ?? null}
                  onShow={(id) => {
                    setEditing(false);
                    setShownId(id);
                  }}
                />
              )}
            </>
          );
        }}
      </Resource>
    </section>
  );
}

/** One version's script; versions never change, so it is read once. */
function JobShellContent({
  targetId,
  summary,
  isCurrent,
  onShowCurrent,
}: {
  targetId: string;
  summary: SiteJobShellSummary;
  isCurrent: boolean;
  onShowCurrent: () => void;
}) {
  const shell = useQuery(`site-job-shell:${summary.id}`, (signal) =>
    siteComputersApi.jobShell(targetId, summary.id, signal),
  );
  return (
    <div className="job-shell-version">
      <p className="badge-group">
        <span>{siteComputersTextTemplates.jobShellShowing(summary.version)}</span>
        {isCurrent ? (
          <span className="status-badge status-finished">{text.jobShellCurrent}</span>
        ) : (
          <button className="button small" onClick={onShowCurrent}>
            {text.jobShellShowCurrent}
          </button>
        )}
      </p>
      <Resource query={shell}>
        {(value) => <pre className="json-view job-shell-content">{value.content}</pre>}
      </Resource>
    </div>
  );
}

/** Starts from the current version (or nothing on a new site) and saves the next one. */
function JobShellEditForm({
  targetId,
  currentId,
  onSaved,
  onCancel,
}: {
  targetId: string;
  currentId: string | null;
  onSaved: (saved: SiteJobShell) => void;
  onCancel: () => void;
}) {
  const current = useQuery(currentId ? `site-job-shell:${currentId}` : null, (signal) =>
    siteComputersApi.jobShell(targetId, currentId!, signal),
  );
  // A new version starts from the current one, so the editor waits for its content.
  if (currentId && current.value === undefined)
    return <Resource query={current}>{() => null}</Resource>;
  return (
    <JobShellDraft
      targetId={targetId}
      initialContent={current.value?.content ?? ''}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

function JobShellDraft({
  targetId,
  initialContent,
  onSaved,
  onCancel,
}: {
  targetId: string;
  initialContent: string;
  onSaved: (saved: SiteJobShell) => void;
  onCancel: () => void;
}) {
  const templateSelectId = useId();
  const [content, setContent] = useState(initialContent);
  const [templateKey, setTemplateKey] = useState('');
  const mutation = useMutation();
  const template = findJobShellTemplate(templateKey);
  return (
    <form
      className="job-shell-draft"
      onSubmit={(event) => {
        event.preventDefault();
        void mutation
          .run(() =>
            siteComputersApi.createJobShell(targetId, { content: parseJobShellContent(content) }),
          )
          .then((saved) => {
            if (saved) onSaved(saved);
          });
      }}
    >
      <fieldset disabled={mutation.pending}>
        <div className="field">
          <label htmlFor={templateSelectId}>{text.jobShellTemplate}</label>
          <div className="site-computer-actions">
            <select
              id={templateSelectId}
              value={templateKey}
              onChange={(event) => setTemplateKey(event.target.value)}
            >
              <option value="">{text.none}</option>
              {JOB_SHELL_TEMPLATES.map((item) => (
                <option key={item.key} value={item.key}>
                  {jobShellTemplateLabels[item.key]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button small"
              disabled={!template}
              onClick={() => template && setContent(template.content)}
            >
              {text.jobShellLoadTemplate}
            </button>
          </div>
          <span className="muted">{text.jobShellLoadTemplateHint}</span>
        </div>
        <JobShellEditor value={content} onChange={setContent} required />
      </fieldset>
      <ErrorNotice message={mutation.error} />
      <div className="site-computer-actions">
        <button
          type="button"
          className="button small"
          disabled={mutation.pending}
          onClick={onCancel}
        >
          {text.cancel}
        </button>
        <button className="button primary small" disabled={mutation.pending}>
          {mutation.pending ? text.loading : text.jobShellSave}
        </button>
      </div>
    </form>
  );
}

function JobShellHistory({
  versions,
  currentId,
  shownId,
  onShow,
}: {
  versions: SiteJobShellSummary[];
  currentId: string | null;
  shownId: string | null;
  onShow: (id: string) => void;
}) {
  return (
    <div className="job-shell-history">
      <h4>{text.jobShellHistory}</h4>
      <p className="muted">{text.jobShellHistoryHint}</p>
      <ResponsiveTable
        rows={versions}
        rowKey={(version) => version.id}
        selectedKey={shownId ?? undefined}
        label={text.jobShellHistory}
        columns={[
          {
            key: 'version',
            priority: 'primary',
            header: text.jobShellVersion,
            render: (version) => (
              <span className="badge-group">
                <span className="mono">
                  {siteComputersTextTemplates.jobShellVersionLabel(version.version)}
                </span>
                {version.id === currentId && (
                  <span className="status-badge status-finished">{text.jobShellCurrent}</span>
                )}
              </span>
            ),
          },
          {
            key: 'createdBy',
            priority: 'secondary',
            header: text.jobShellCreatedBy,
            render: (version) => version.createdByName ?? version.createdBy,
          },
          {
            key: 'createdAt',
            priority: 'secondary',
            header: text.jobShellCreatedAt,
            render: (version) => formatDate(version.createdAt),
          },
          {
            key: 'size',
            priority: 'secondary',
            header: text.size,
            render: (version) => formatBytes(version.sizeBytes),
          },
          {
            key: 'sha256',
            priority: 'secondary',
            header: text.sha256,
            className: 'mono',
            render: (version) => <span title={version.sha256}>{shortSha256(version.sha256)}</span>,
          },
          {
            key: 'show',
            priority: 'primary',
            header: text.actions,
            render: (version) => (
              <button
                className="button small"
                disabled={version.id === shownId}
                onClick={() => onShow(version.id)}
              >
                {text.jobShellShow}
              </button>
            ),
          },
        ]}
      />
    </div>
  );
}

import { CopyButton } from './CopyButton';
import { manualSubmitCommand, type ManualSubmissionGroup } from '../lib/manualSubmission';
import { text } from '../i18n/catalog';
import { jobsTextTemplates } from '../i18n/jobs';

/** The command for one manual site, with a button to copy it. */
export function ManualSubmitCommand({ targetId }: { targetId: string }) {
  const command = manualSubmitCommand(targetId);
  return (
    <div className="copyable-value">
      <code>{command}</code>
      <CopyButton value={command} />
    </div>
  );
}

/**
 * Jobs of manual sites wait until their requester runs `mado-tracking submit` on the site's login
 * node; tracking cannot submit them itself, so the Jobs page says so above the list.
 */
export function ManualSubmissionNotice({ groups }: { groups: ManualSubmissionGroup[] }) {
  if (!groups.length) return null;
  return (
    <section className="notice manual-submission" aria-label={text.manualSubmissionTitle}>
      <strong>{text.manualSubmissionTitle}</strong>
      <p>{text.manualSubmissionHint}</p>
      <ul>
        {groups.map((group) => (
          <li key={group.targetId}>
            <span>{jobsTextTemplates.manualSubmissionWaiting(group.targetName, group.waitingJobs)}</span>
            <ManualSubmitCommand targetId={group.targetId} />
          </li>
        ))}
      </ul>
    </section>
  );
}

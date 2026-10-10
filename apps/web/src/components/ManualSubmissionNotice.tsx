import { CopyButton } from './CopyButton';
import {
  manualSubmitCommand,
  type ManualSubmissionGroup,
  type ManualSubmitOptions,
} from '../lib/manualSubmission';
import { text } from '../i18n/catalog';
import { jobsTextTemplates } from '../i18n/jobs';

/** The command for one manual site, with a button to copy it. */
export function ManualSubmitCommand({
  targetId,
  options,
}: {
  targetId: string;
  options?: ManualSubmitOptions;
}) {
  const command = manualSubmitCommand(targetId, options);
  return (
    <div className="copyable-value">
      <code>{command}</code>
      <CopyButton value={command} />
    </div>
  );
}

/**
 * Jobs of manual sites wait until their requester runs `mado-tracking submit` on the site;
 * tracking cannot submit them itself, so the Jobs page says so above the list.
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

/**
 * How a manual site's Jobs are submitted, in its details: once on a login node, by waiting on a
 * PC that is the computer itself, and for its owner, everyone's Jobs (`--all`).
 */
export function ManualSubmissionGuide({ targetId, isOwner }: { targetId: string; isOwner: boolean }) {
  const commands: Array<{ label: string; options: ManualSubmitOptions }> = [
    { label: text.manualGuideOnce, options: {} },
    { label: text.manualGuideWatch, options: { watch: true } },
  ];
  // Only the owner may take everyone's Jobs; others get 403 site_owner_required.
  if (isOwner) commands.push({ label: text.manualGuideAll, options: { all: true, watch: true } });
  return (
    <section className="site-computer-section" aria-label={text.manualGuideTitle}>
      <h3>{text.manualGuideTitle}</h3>
      <p>{text.manualGuideHint}</p>
      <ul className="site-command-list">
        {commands.map(({ label, options }) => (
          <li key={label}>
            <span>{label}</span>
            <ManualSubmitCommand targetId={targetId} options={options} />
          </li>
        ))}
      </ul>
      <p className="muted">{text.manualGuideToken}</p>
    </section>
  );
}

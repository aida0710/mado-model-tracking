import { CopyButton } from './CopyButton';
import {
  manualSubmitCommand,
  OWNER_SUBMIT_OPTIONS,
  type ManualSiteOwnership,
  type ManualSubmissionGroup,
  type ManualSubmitOptions,
} from '../lib/manualSubmission';
import { text } from '../i18n/catalog';
import { jobsTextTemplates } from '../i18n/jobs';
import { siteComputersTextTemplates } from '../i18n/siteComputers';

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
 * What the viewer is told about the owner below a manual site's commands: on their own computer,
 * which Jobs `--all` takes; on someone else's, that where its owner waits with `--watch --all`
 * (their PC, say) the owner submits the Jobs. A global site has no owner to mention.
 */
function ManualSiteOwnerNote({ ownership }: { ownership: ManualSiteOwnership }) {
  if (ownership.kind === 'own') return <p className="muted">{text.manualGuideAllScope}</p>;
  if (ownership.kind === 'someoneElse')
    return (
      <p className="muted">{siteComputersTextTemplates.manualGuideOwnerSubmits(ownership.ownerName)}</p>
    );
  return null;
}

/**
 * How a manual site's waiting Jobs get submitted, for the viewer: each requester runs the command
 * with their own account, and the owner of a computer may also take everyone's, waiting on it
 * (`--watch --all`) once per Project whose Jobs it takes.
 */
export function WaitingJobSubmission({
  targetId,
  ownership,
}: {
  targetId: string;
  ownership: ManualSiteOwnership;
}) {
  return (
    <>
      <ManualSubmitCommand targetId={targetId} />
      {ownership.kind === 'own' && (
        <>
          <p className="muted manual-submit-owner">{text.manualGuideAll}</p>
          <ManualSubmitCommand targetId={targetId} options={OWNER_SUBMIT_OPTIONS} />
        </>
      )}
      <ManualSiteOwnerNote ownership={ownership} />
    </>
  );
}

/** The selected Job's notice while it waits for `mado-tracking submit`. */
export function WaitingJobNotice({
  targetId,
  ownership,
  isRequester,
}: {
  targetId: string;
  ownership: ManualSiteOwnership;
  /** The viewer created the Job's Run. */
  isRequester: boolean;
}) {
  return (
    <div className="notice manual-submission">
      <p>{isRequester ? text.manualSubmissionOwnHint : text.manualSubmissionHint}</p>
      <WaitingJobSubmission targetId={targetId} ownership={ownership} />
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
            <WaitingJobSubmission targetId={group.targetId} ownership={group.ownership} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * How a manual site's Jobs are submitted, in its details: once on a login node, by waiting on a
 * PC that is the computer itself, and for its owner, everyone's Jobs (`--all`) of the token's
 * Project. Others are told that the owner may submit them instead.
 */
export function ManualSubmissionGuide({
  targetId,
  ownership,
}: {
  targetId: string;
  ownership: ManualSiteOwnership;
}) {
  const commands: Array<{ label: string; options: ManualSubmitOptions }> = [
    { label: text.manualGuideOnce, options: {} },
    { label: text.manualGuideWatch, options: { watch: true } },
  ];
  // Only the owner may take everyone's Jobs; others get 403 site_owner_required.
  if (ownership.kind === 'own')
    commands.push({ label: text.manualGuideAll, options: OWNER_SUBMIT_OPTIONS });
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
      <ManualSiteOwnerNote ownership={ownership} />
      <p className="muted">{text.manualGuideToken}</p>
    </section>
  );
}

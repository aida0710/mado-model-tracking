import { siteComputersApi } from '../api/siteComputers';
import { useQuery } from '../hooks/useQuery';
import { Resource } from './Feedback';
import { formatDate } from '../lib/format';
import { siteComputersTextTemplates } from '../i18n/siteComputers';

/**
 * The job shell version a site Job was submitted with, and the script itself to read. Versions
 * never change, so it shows exactly what ran even after the site's job shell was edited.
 */
export function SiteJobShellVersion({ targetId, jobShellId }: { targetId: string; jobShellId: string }) {
  const shell = useQuery(`site-job-shell:${jobShellId}`, (signal) =>
    siteComputersApi.jobShell(targetId, jobShellId, signal),
  );
  return (
    <Resource query={shell}>
      {(value) => (
        <details>
          <summary>
            <span className="mono">{siteComputersTextTemplates.jobShellVersionLabel(value.version)}</span>
            {` · ${formatDate(value.createdAt)}`}
          </summary>
          <pre className="json-view job-shell-content">{value.content}</pre>
        </details>
      )}
    </Resource>
  );
}

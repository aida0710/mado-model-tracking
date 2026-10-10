import { useId } from 'react';
import type { LauncherCreated } from '@mmt/contracts';
import { Dialog } from '../components/Dialog';
import { CopyButton } from '../components/CopyButton';
import { buildLauncherConfigExample } from '../lib/launcherConfig';
import { text } from '../i18n/catalog';
import { launchersTextTemplates } from '../i18n/launchers';

/**
 * A launcher's new token, shown once: the API returns it only in this answer. launcher.toml names
 * the file the token goes into, so the example itself never contains the token.
 */
export function LauncherTokenDialog({
  issued,
  onClose,
}: {
  issued: LauncherCreated;
  onClose: () => void;
}) {
  const tokenId = useId();
  const config = buildLauncherConfigExample({
    apiUrl: window.location.origin,
    launcherName: issued.launcher.name,
  });
  return (
    <Dialog title={launchersTextTemplates.launcherTokenTitle(issued.launcher.name)} onClose={onClose} wide>
      <p className="notice">{text.launcherTokenOnce}</p>
      <div className="field">
        <label htmlFor={tokenId}>{text.launcherTokenValue}</label>
        <input
          id={tokenId}
          className="mono"
          readOnly
          value={issued.token}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.target.select()}
        />
        <div>
          <CopyButton value={issued.token} />
        </div>
      </div>
      <div className="field">
        <span>{text.launcherConfigExample}</span>
        <p className="muted">{text.launcherConfigExampleHint}</p>
        <pre className="json-view" data-testid="launcher-config-example">
          {config}
        </pre>
        <div>
          <CopyButton value={config} />
        </div>
      </div>
      <footer>
        <button className="button primary" onClick={onClose}>
          {text.close}
        </button>
      </footer>
    </Dialog>
  );
}

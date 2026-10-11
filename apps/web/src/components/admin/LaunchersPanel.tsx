import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { Launcher, LauncherCreated } from '@mmt/contracts';
import { launchersApi } from '../../api/launchers';
import { useQuery } from '../../hooks/useQuery';
import { getFieldValue } from '../../lib/formValues';
import { ConfirmDialog } from '../ConfirmDialog';
import { FormDialog } from '../FormDialog';
import { Resource } from '../Feedback';
import { SettingsPageHeader } from '../SettingsPageHeader';
import { LaunchersTable } from './LaunchersTable';
import { LauncherTokenDialog } from '../../dialogs/LauncherTokenDialog';
import { text } from '../../i18n/catalog';
import { launchersTextTemplates } from '../../i18n/launchers';

// Matches the API's limit on a launcher's name.
const MAX_LAUNCHER_NAME_LENGTH = 200;

type LauncherAction = { kind: 'rotate' | 'revoke'; launcher: Launcher };

/**
 * The admin "launchers" section: registering launchers, replacing their tokens and revoking
 * them. A new token is shown once, with an example launcher.toml.
 */
export function LaunchersPanel() {
  const launchers = useQuery('launchers', launchersApi.list);
  const [isCreating, setCreating] = useState(false);
  const [action, setAction] = useState<LauncherAction | null>(null);
  const [issued, setIssued] = useState<LauncherCreated | null>(null);
  const showIssued = (created: LauncherCreated) => {
    setIssued(created);
    launchers.reload();
  };
  return (
    <section className="admin-launchers">
      <SettingsPageHeader
        section="launchers"
        actions={
          <>
            <button className="button primary" onClick={() => setCreating(true)}>
              <Plus size={15} />
              {text.newLauncher}
            </button>
            <button className="icon-button" aria-label={text.refresh} onClick={launchers.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <p className="muted">{text.launchersDescription}</p>
      <Resource query={launchers}>
        {(items) => (
          <LaunchersTable
            launchers={items}
            onRotateToken={(launcher) => setAction({ kind: 'rotate', launcher })}
            onRevoke={(launcher) => setAction({ kind: 'revoke', launcher })}
          />
        )}
      </Resource>
      {isCreating && (
        <FormDialog
          title={text.newLauncher}
          submitLabel={text.create}
          fields={[
            { name: 'name', label: text.name, required: true, maxLength: MAX_LAUNCHER_NAME_LENGTH },
          ]}
          onSubmit={(values) => launchersApi.create({ name: getFieldValue(values, 'name').trim() })}
          onSaved={(created) => {
            setCreating(false);
            showIssued(created);
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {action?.kind === 'rotate' && (
        <ConfirmDialog
          title={text.launcherRotateTitle}
          message={launchersTextTemplates.launcherRotateConfirm(action.launcher.name)}
          confirmLabel={text.launcherRotateToken}
          destructive
          onConfirm={async () => showIssued(await launchersApi.rotateToken(action.launcher.id))}
          onConfirmed={() => setAction(null)}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'revoke' && (
        <ConfirmDialog
          title={text.launcherRevokeTitle}
          message={launchersTextTemplates.launcherRevokeConfirm(action.launcher.name)}
          confirmLabel={text.launcherRevoke}
          destructive
          onConfirm={() => launchersApi.revoke(action.launcher.id)}
          onConfirmed={() => {
            setAction(null);
            launchers.reload();
          }}
          onClose={() => setAction(null)}
        />
      )}
      {issued && <LauncherTokenDialog issued={issued} onClose={() => setIssued(null)} />}
    </section>
  );
}

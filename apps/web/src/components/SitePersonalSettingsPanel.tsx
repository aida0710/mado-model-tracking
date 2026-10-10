import { useState } from 'react';
import type { ComputeTargetDetails, SitePersonalSettings } from '@mmt/contracts';
import { siteComputersApi } from '../api/siteComputers';
import { useMutation } from '../hooks/useMutation';
import { useQueryPolledWhileActive } from '../hooks/useQueryPolledWhileActive';
import type { FormField, FormValues } from '../types/form';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorNotice, Resource } from './Feedback';
import { FormFields } from './FormFields';
import { SiteConnectionChecks } from './SiteConnectionChecks';
import { SiteLoginKey } from './SiteLoginKey';
import { isKeyReady, isKeyRequested } from '../lib/siteComputerDisplay';
import {
  buildPersonalSettingsInput,
  personalSettingsFormValues,
  personalSettingsScope,
  type PersonalSettingsScope,
} from '../lib/sitePersonalSettingsInput';
import { text } from '../i18n/catalog';

/**
 * One's own settings for a site: the account the launcher logs in as where each person uses their
 * own (then also the launcher's key for it and the login checks), and one's work directory and
 * variables. A site with a shared account has none.
 */
export function SitePersonalSettingsPanel({
  target,
  userId,
}: {
  target: ComputeTargetDetails;
  userId: string;
}) {
  const scope = personalSettingsScope(target);
  return (
    <section className="site-computer-section" aria-label={text.sitePersonalTitle}>
      <h3>{text.sitePersonalTitle}</h3>
      {scope === 'none' ? (
        <p className="muted">{text.sitePersonalSharedAccountNotice}</p>
      ) : (
        <SavedPersonalSettings target={target} scope={scope} userId={userId} />
      )}
    </section>
  );
}

function SavedPersonalSettings({
  target,
  scope,
  userId,
}: {
  target: ComputeTargetDetails;
  scope: Exclude<PersonalSettingsScope, 'none'>;
  userId: string;
}) {
  const settings = useQueryPolledWhileActive(
    `site-personal-settings:${target.id}`,
    (signal) => siteComputersApi.myPersonalSettings(target.id, signal),
    (item) => isKeyRequested(item?.key),
  );
  return (
    <>
      <p className="muted">{text.sitePersonalHint}</p>
      <Resource query={settings}>
        {(item) => (
          <PersonalSettingsForm
            targetId={target.id}
            scope={scope}
            item={item}
            userId={userId}
            onChanged={settings.reload}
          />
        )}
      </Resource>
    </>
  );
}

function PersonalSettingsForm({
  targetId,
  scope,
  item,
  userId,
  onChanged,
}: {
  targetId: string;
  scope: Exclude<PersonalSettingsScope, 'none'>;
  item: SitePersonalSettings | null;
  userId: string;
  onChanged: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => personalSettingsFormValues(item));
  const [isSaved, setSaved] = useState(false);
  const [isDeleting, setDeleting] = useState(false);
  const mutation = useMutation();
  const fields: FormField[] = [
    {
      name: 'accountName',
      label: text.siteAccountName,
      required: true,
      visible: () => scope === 'withAccount',
    },
    { name: 'personalWorkDirectory', label: text.sitePersonalWorkDirectory },
    { name: 'personalVariables', label: text.sitePersonalVariables, type: 'textarea' },
  ];
  const save = () =>
    void mutation
      .run(() =>
        siteComputersApi.saveMyPersonalSettings(targetId, buildPersonalSettingsInput(values, scope)),
      )
      .then((saved) => {
        if (!saved) return;
        setValues(personalSettingsFormValues(saved));
        setSaved(true);
        onChanged();
      });
  return (
    <>
      {scope === 'withAccount' && !item?.accountName && (
        <p className="notice">{text.siteAccountRequiredNotice}</p>
      )}
      {!item && <p className="muted">{text.sitePersonalNone}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset disabled={mutation.pending}>
          <FormFields
            fields={fields}
            values={values}
            onChange={(next) => {
              setValues(next);
              setSaved(false);
              mutation.clearError();
            }}
          />
        </fieldset>
        <ErrorNotice message={mutation.error} />
        {isSaved && (
          <p className="notice success" role="status">
            {text.sitePersonalSaved}
          </p>
        )}
        <div className="site-computer-actions">
          <button className="button primary small" disabled={mutation.pending}>
            {mutation.pending ? text.loading : text.sitePersonalSave}
          </button>
          {item && (
            <button
              type="button"
              className="button small"
              disabled={mutation.pending}
              onClick={() => setDeleting(true)}
            >
              {text.sitePersonalDelete}
            </button>
          )}
        </div>
      </form>
      {item?.key && (
        <div className="site-personal-key">
          <h4>{text.sitePersonalKeyTitle}</h4>
          <SiteLoginKey
            targetId={targetId}
            siteKey={item.key}
            personal
            accountName={item.accountName}
            onRequested={onChanged}
          />
          <SiteConnectionChecks
            targetId={targetId}
            personal
            userId={userId}
            isKeyReady={isKeyReady(item.key)}
          />
        </div>
      )}
      {isDeleting && (
        <ConfirmDialog
          title={text.sitePersonalDelete}
          message={text.sitePersonalDeleteConfirm}
          confirmLabel={text.sitePersonalDelete}
          destructive
          onConfirm={() => siteComputersApi.deleteMyPersonalSettings(targetId)}
          onConfirmed={() => {
            setDeleting(false);
            setSaved(false);
            setValues(personalSettingsFormValues(null));
            onChanged();
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

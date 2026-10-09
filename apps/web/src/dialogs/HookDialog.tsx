import { useState } from 'react';
import type { Hook, HookCreated } from '@mmt/contracts';
import type { HookCatalog } from '../types/hooks';
import { useHookForm } from '../hooks/useHookForm';
import { useProject } from '../hooks/useProject';
import { Dialog } from '../components/Dialog';
import { HookFields } from '../components/HookFields';
import { CopyButton } from '../components/CopyButton';
import { ErrorNotice } from '../components/Feedback';
import { text } from '../i18n/catalog';
import { hookWebhookSignatureHints } from '../i18n/hooks';

/** One value of the new webhook, shown once with a copy button. */
function WebhookValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="copyable-value">
        <code>{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

/**
 * The secret of a new webhook hook. The API keeps it encrypted and never returns it again, so it
 * is shown here once, next to the path the sender posts to.
 */
function WebhookCreated({ created, onClose }: { created: HookCreated; onClose: () => void }) {
  const signature = created.hook.webhookSignature;
  return (
    <Dialog title={text.hookWebhookCreated} onClose={onClose}>
      <p className="notice">{text.hookWebhookSecretOnce}</p>
      <div className="hook-webhook-values">
        {created.webhookSecret && (
          <WebhookValue label={text.hookWebhookSecret} value={created.webhookSecret} />
        )}
        {created.webhookPath && <WebhookValue label={text.hookWebhookPath} value={created.webhookPath} />}
        <p className="muted">{text.hookWebhookPathHint}</p>
        {signature && <p className="muted">{hookWebhookSignatureHints[signature]}</p>}
      </div>
      <footer>
        <button className="button primary" onClick={onClose}>
          {text.close}
        </button>
      </footer>
    </Dialog>
  );
}

/**
 * Creates a hook. onCreated runs as soon as the API has it (the list can refresh behind the
 * secret); onClose ends the dialog, after the secret of a webhook hook has been shown.
 */
export function HookDialog({
  catalog,
  onCreated,
  onClose,
}: {
  catalog: HookCatalog;
  onCreated: (hook: Hook) => void;
  onClose: () => void;
}) {
  const { project } = useProject();
  const form = useHookForm({ projectId: project.id, catalog });
  const [created, setCreated] = useState<HookCreated | null>(null);
  if (created) return <WebhookCreated created={created} onClose={onClose} />;
  return (
    <Dialog title={text.newHook} onClose={onClose} busy={form.pending} wide>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.save().then((result) => {
            if (!result) return;
            onCreated(result.hook);
            if (result.webhookSecret) setCreated(result);
            else onClose();
          });
        }}
      >
        <fieldset disabled={form.pending}>
          <HookFields values={form.values} catalog={catalog} onChange={form.changeValues} />
        </fieldset>
        <ErrorNotice message={form.error} />
        <footer>
          <button type="button" className="button" disabled={form.pending} onClick={onClose}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={form.pending}>
            {form.pending ? text.loading : text.create}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

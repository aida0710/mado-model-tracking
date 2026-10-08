import type { PluginConnection } from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { usePluginForm } from '../hooks/usePluginForm';
import { Dialog } from '../components/Dialog';
import { FormFields } from '../components/FormFields';
import { ErrorNotice } from '../components/Feedback';
import { text } from '../i18n/catalog';

export function PluginDialog({ plugin, onClose, onSaved }: {
  plugin?: PluginConnection; onClose: () => void; onSaved: (plugin: PluginConnection) => void;
}) {
  const { project } = useProject();
  const form = usePluginForm({ projectId: project.id, plugin });
  return <Dialog title={plugin ? text.editPlugin : text.newPlugin} onClose={onClose} busy={form.pending}>
    <form onSubmit={(event) => {
      event.preventDefault();
      void form.save().then((saved) => { if (saved) onSaved(saved); });
    }} data-testid="plugin-edit-form">
      <fieldset disabled={form.pending}>
        <button type="button" className="button small" onClick={form.applyMadoPreset}>{text.madoPreset}</button>
        <p className="muted">{text.madoPresetHint}</p>
        <FormFields fields={[
          { name: 'name', label: text.name, required: true },
          { name: 'baseUrl', label: text.baseUrl, type: 'url', required: true },
          { name: 'tokenEnv', label: text.tokenEnv, required: true },
          { name: 'enabled', label: text.enabled, type: 'checkbox' },
        ]} values={form.values} onChange={form.changeValues} />
      </fieldset>
      <ErrorNotice message={form.error} />
      <footer>
        <button type="button" className="button" disabled={form.pending} onClick={onClose}>{text.cancel}</button>
        <button className="button primary" disabled={form.pending}>{form.pending ? text.loading : text.save}</button>
      </footer>
    </form>
  </Dialog>;
}

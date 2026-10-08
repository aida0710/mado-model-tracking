import type { ModelAutomationRule } from '@mmt/contracts';
import type { AutomationCatalog } from '../types/modelAutomation';
import { useAutomationRuleForm } from '../hooks/useAutomationRuleForm';
import { useProject } from '../hooks/useProject';
import { Dialog } from '../components/Dialog';
import { AutomationRuleFields } from '../components/AutomationRuleFields';
import { ErrorNotice } from '../components/Feedback';
import { text } from '../i18n/catalog';

export function AutomationRuleDialog({
  catalog,
  initialFamilies,
  onClose,
  onSaved,
}: {
  catalog: AutomationCatalog;
  initialFamilies: string[];
  onClose: () => void;
  onSaved: (rule: ModelAutomationRule) => void;
}) {
  const { project } = useProject();
  const form = useAutomationRuleForm({ projectId: project.id, catalog, initialFamilies });
  return (
    <Dialog title={text.newAutomationRule} onClose={onClose} busy={form.pending} wide>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.save().then((rule) => {
            if (rule) onSaved(rule);
          });
        }}
      >
        <fieldset disabled={form.pending}>
          <AutomationRuleFields
            values={form.values}
            catalog={catalog}
            onChange={form.changeValues}
          />
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

import { useState } from 'react';
import { Dialog } from './Dialog';
import { FormFields } from './FormFields';
import { createInitialValues } from '../lib/formValues';
import type { FormField } from '../types/form';
import { ErrorNotice } from './Feedback';
import { useMutation } from '../hooks/useMutation';
import { text } from '../i18n/catalog';
import type { FormValues } from '../lib/formValues';

export function FormDialog<T>({
  title,
  fields,
  onSubmit,
  onSaved,
  onClose,
  submitLabel = text.save,
  fullScreenOnNarrow = false,
}: {
  title: string;
  fields: FormField[];
  onSubmit: (values: FormValues) => Promise<T>;
  onSaved: (value: T) => void;
  onClose: () => void;
  submitLabel?: string;
  fullScreenOnNarrow?: boolean;
}) {
  const [values, setValues] = useState(() => createInitialValues(fields));
  const mutation = useMutation();
  return (
    <Dialog title={title} onClose={onClose} busy={mutation.pending} fullScreenOnNarrow={fullScreenOnNarrow}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run(async () => ({ saved: await onSubmit(values) }))
            .then((saved) => {
              if (saved) onSaved(saved.saved);
            });
        }}
      >
        <fieldset disabled={mutation.pending}>
          <FormFields fields={fields} values={values} onChange={setValues} />
        </fieldset>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending}>
            {mutation.pending ? text.loading : submitLabel}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

import type { ReactNode } from 'react';
import { Dialog } from './Dialog';
import { ErrorNotice } from './Feedback';
import { useMutation } from '../hooks/useMutation';
import { text } from '../i18n/catalog';

/** Asks before an operation that has no form, such as revoking a token. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onConfirmed,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
  onConfirmed: () => void;
  onClose: () => void;
}) {
  const mutation = useMutation();
  return (
    <Dialog title={title} onClose={onClose} busy={mutation.pending} fullScreenOnNarrow={false}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run(async () => {
              await onConfirm();
              return true;
            })
            .then((confirmed) => {
              if (confirmed) onConfirmed();
            });
        }}
      >
        <p>{message}</p>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button
            className={destructive ? 'button danger' : 'button primary'}
            disabled={mutation.pending}
          >
            {mutation.pending ? text.loading : confirmLabel}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { text } from '../i18n/catalog';

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
  fullScreenOnNarrow = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  /** Below --bp-sm the dialog fills the screen, for forms too long for a centered box. */
  fullScreenOnNarrow?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={[
        'dialog',
        wide && 'wide',
        fullScreenOnNarrow && 'full-screen-on-narrow',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby={titleId}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={onClose} disabled={busy} aria-label={text.close}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

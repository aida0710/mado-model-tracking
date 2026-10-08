import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { text } from '../i18n/catalog';

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
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
      className={`${wide ? 'dialog wide' : 'dialog'} ${className}`.trim()}
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

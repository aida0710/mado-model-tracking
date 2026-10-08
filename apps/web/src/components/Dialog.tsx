import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { text } from '../i18n/catalog';

/**
 * The dialog's classes. Below --bp-sm a dialog fills the screen, or with `fullScreenOnNarrow` off
 * (short confirmations) it becomes a sheet from the bottom edge.
 */
export function dialogClassName({
  wide,
  fullScreenOnNarrow,
  className,
}: {
  wide: boolean;
  fullScreenOnNarrow: boolean;
  className: string;
}) {
  return [
    'dialog',
    wide && 'wide',
    fullScreenOnNarrow ? 'fullscreen-on-narrow' : 'sheet-on-narrow',
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
  fullScreenOnNarrow = true,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
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
      className={dialogClassName({ wide, fullScreenOnNarrow, className })}
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

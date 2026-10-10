import { useId } from 'react';
import { text } from '../i18n/catalog';

// Tall enough to read a whole section of a job shell without scrolling the dialog.
const JOB_SHELL_EDITOR_ROWS = 18;

/** A job shell as plain text: monospaced, unwrapped and without spelling marks. */
export function JobShellEditor({
  value,
  onChange,
  required = false,
}: {
  value: string;
  onChange: (content: string) => void;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {text.jobShell}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <textarea
        id={id}
        className="mono job-shell-editor"
        value={value}
        rows={JOB_SHELL_EDITOR_ROWS}
        required={required}
        spellCheck={false}
        wrap="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

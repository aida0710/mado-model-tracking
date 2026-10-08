import { CopyButton } from '../CopyButton';
import { text } from '../../i18n/catalog';

/** Shows a temporary password once, with a copy button; it is not shown again after closing. */
export function TemporaryPasswordNotice({ password }: { password: string }) {
  return (
    <div className="temporary-password">
      <span className="field-label">{text.temporaryPasswordTitle}</span>
      <div className="temporary-password-value">
        <code data-testid="temporary-password">{password}</code>
        <CopyButton value={password} />
      </div>
      <p className="muted">{text.temporaryPasswordOnce}</p>
    </div>
  );
}

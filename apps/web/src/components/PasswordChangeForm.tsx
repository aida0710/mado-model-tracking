import { useState } from 'react';
import { authApi } from '../api/auth';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from './Feedback';
import { text } from '../i18n/catalog';
import { changePasswordErrorMessage } from '../lib/authErrorMessages';

/** Changes the signed-in local user's password; the API keeps this session and ends the others. */
export function PasswordChangeForm({
  isRequired = false,
  onChanged = () => undefined,
}: {
  isRequired?: boolean;
  onChanged?: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isChanged, setIsChanged] = useState(false);
  const mutation = useMutation();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          if (newPassword !== confirmation) throw new Error(text.newPasswordMismatch);
          try {
            await authApi.changePassword({ currentPassword, newPassword });
          } catch (error) {
            throw new Error(changePasswordErrorMessage(error));
          }
          setCurrentPassword('');
          setNewPassword('');
          setConfirmation('');
          setIsChanged(true);
          onChanged();
        });
      }}
    >
      {isRequired && <p className="muted">{text.changePasswordRequired}</p>}
      <label className="field">
        <span>{text.currentPassword}</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </label>
      <label className="field">
        <span>{text.newPassword}</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </label>
      <label className="field">
        <span>{text.confirmNewPassword}</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      <p className="muted">{text.newPasswordHint}</p>
      {isChanged && (
        <p className="muted" role="status">
          {text.passwordChanged}
        </p>
      )}
      <ErrorNotice message={mutation.error} />
      <button className="button primary" disabled={mutation.pending}>
        {text.changePassword}
      </button>
    </form>
  );
}

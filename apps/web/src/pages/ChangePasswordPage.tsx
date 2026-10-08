import { useState } from 'react';
import { authApi } from '../api/auth';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from '../components/Feedback';
import { text } from '../i18n/catalog';
import { changePasswordErrorMessage } from '../lib/authErrorMessages';

// isRequired: shown by AuthGate before any other screen until the initial password is replaced.
// onChanged reloads the session there; a voluntary change keeps the current session as is.
export function ChangePasswordPage({
  isRequired,
  onChanged = () => undefined,
}: {
  isRequired: boolean;
  onChanged?: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isChanged, setIsChanged] = useState(false);
  const mutation = useMutation();
  const form = (
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
  if (!isRequired)
    return (
      <section className="login-card">
        <h1>{text.changePasswordTitle}</h1>
        {form}
      </section>
    );
  // The required screen replaces the app, so it also offers the only way out besides changing.
  return (
    <div className="login-page">
      <div className="login-brand">{text.appName}</div>
      <main className="login-card">
        <h1>{text.changePasswordTitle}</h1>
        {form}
        <button
          type="button"
          className="button"
          disabled={mutation.pending}
          onClick={() =>
            void mutation.run(async () => {
              await authApi.logout();
              onChanged();
            })
          }
        >
          {text.logout}
        </button>
      </main>
    </div>
  );
}

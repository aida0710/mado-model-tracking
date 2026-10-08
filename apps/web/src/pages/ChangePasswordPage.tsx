import { authApi } from '../api/auth';
import { useMutation } from '../hooks/useMutation';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { ErrorNotice } from '../components/Feedback';
import { text } from '../i18n/catalog';

// isRequired: shown by AuthGate before any other screen until the initial password is replaced.
// onChanged reloads the session there; a voluntary change keeps the current session as is.
export function ChangePasswordPage({
  isRequired,
  onChanged = () => undefined,
}: {
  isRequired: boolean;
  onChanged?: () => void;
}) {
  const logout = useMutation();
  const form = <PasswordChangeForm isRequired={isRequired} onChanged={onChanged} />;
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
        <ErrorNotice message={logout.error} />
        <button
          type="button"
          className="button"
          disabled={logout.pending}
          onClick={() =>
            void logout.run(async () => {
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

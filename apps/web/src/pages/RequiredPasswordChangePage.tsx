import { authApi } from '../api/auth';
import { useMutation } from '../hooks/useMutation';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { ErrorNotice } from '../components/Feedback';
import { ProductLogo } from '../components/ProductLogo';
import { text } from '../i18n/catalog';

/**
 * Shown by AuthGate before any other screen until the initial password is replaced; onChanged
 * reloads the session. It replaces the app, so it also offers the only way out besides changing.
 * A voluntary change is PasswordChangePage in 全体設定.
 */
export function RequiredPasswordChangePage({ onChanged }: { onChanged: () => void }) {
  const logout = useMutation();
  return (
    <div className="login-page">
      <main className="login-card">
        <div className="login-mark">
          <ProductLogo />
        </div>
        <h1>{text.changePasswordTitle}</h1>
        <PasswordChangeForm isRequired onChanged={onChanged} />
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

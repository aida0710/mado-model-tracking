import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { SettingsPageHeader } from '../components/SettingsPageHeader';
import { canChangeOwnPassword } from '../lib/permissions';
import { settingsSectionPath } from '../layout/settingsSections';
import { text } from '../i18n/catalog';

/**
 * 全体設定 → アカウント → パスワードの変更 (/settings/account/password), for local accounts.
 * SSO users change theirs in the IdP, so they are sent to their account instead.
 */
export function PasswordChangePage() {
  const auth = useAuth();
  if (!canChangeOwnPassword(auth.user))
    return <Navigate replace to={settingsSectionPath('account')} />;
  return (
    <>
      <SettingsPageHeader section="account" title={text.passwordChange} />
      <div className="account-page">
        <section className="account-section">
          <PasswordChangeForm />
        </section>
      </div>
    </>
  );
}

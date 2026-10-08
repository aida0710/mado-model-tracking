import { useState } from 'react';
import type { AuthConfig } from '@mmt/contracts';
import { authApi } from '../api/auth';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from '../components/Feedback';
import { LocalLoginForm } from '../components/LocalLoginForm';
import { text } from '../i18n/catalog';
import { rememberAuthReturnPath } from '../lib/authReturnPath';
import { loginMethods } from '../lib/loginMethods';

function DevelopmentLoginForm({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const mutation = useMutation();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          await authApi.devLogin(email, displayName);
          onLogin();
        });
      }}
    >
      <p className="muted">{text.devLoginHint}</p>
      <label className="field">
        <span>{text.email}</span>
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="field">
        <span>{text.displayName}</span>
        <input
          required
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <ErrorNotice message={mutation.error} />
      <button className="button primary" disabled={mutation.pending}>
        {text.devLogin}
      </button>
    </form>
  );
}

// hybrid shows SSO as the main path and the local account form below it as the fallback.
export function LoginPage({ config, onLogin }: { config: AuthConfig; onLogin: () => void }) {
  const methods = loginMethods(config);
  return (
    <div className="login-page">
      <div className="login-brand">{text.appName}</div>
      <main className="login-card">
        <h1>{text.loginTitle}</h1>
        {methods.development && <DevelopmentLoginForm onLogin={onLogin} />}
        {methods.sso && (
          <a
            className="button primary"
            href={methods.sso.loginUrl}
            onClick={() =>
              rememberAuthReturnPath(location.pathname + location.search + location.hash)
            }
          >
            {methods.sso.label || text.login}
          </a>
        )}
        {methods.sso && methods.local && <p className="muted">{text.localLoginSeparator}</p>}
        {methods.local && <LocalLoginForm isPrimary={!methods.sso} onLogin={onLogin} />}
        {!methods.development && !methods.sso && !methods.local && (
          <ErrorNotice message={text.ssoUnavailable} />
        )}
      </main>
    </div>
  );
}

import { useState } from 'react';
import type { AuthConfig } from '@mmt/contracts';
import { authApi } from '../api/auth';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from '../components/Feedback';
import { text } from '../i18n/catalog';
import { rememberAuthReturnPath } from '../lib/authReturnPath';

export function LoginPage({ config, onLogin }: { config: AuthConfig; onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const mutation = useMutation();
  return (
    <div className="login-page">
      <div className="login-brand">{text.appName}</div>
      <main className="login-card">
        <h1>{text.loginTitle}</h1>
        {config.mode === 'development' ? (
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
        ) : (
          config.methods.oidc && (
            <a
              className="button primary"
              href={config.methods.oidc.loginUrl}
              onClick={() =>
                rememberAuthReturnPath(location.pathname + location.search + location.hash)
              }
            >
              {config.methods.oidc.label || text.login}
            </a>
          )
        )}
      </main>
    </div>
  );
}

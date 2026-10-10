import { useState } from 'react';
import { authApi } from '../api/auth';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from './Feedback';
import { text } from '../i18n/catalog';
import { localLoginErrorMessage } from '../lib/authErrorMessages';

export function LocalLoginForm({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          try {
            await authApi.localLogin({ username, password });
          } catch (error) {
            setPassword('');
            throw new Error(localLoginErrorMessage(error));
          }
          onLogin();
        });
      }}
    >
      <label className="field">
        <span>{text.username}</span>
        <input
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="field">
        <span>{text.password}</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <ErrorNotice message={mutation.error} />
      <button className="button primary" disabled={mutation.pending}>
        {text.localLogin}
      </button>
    </form>
  );
}

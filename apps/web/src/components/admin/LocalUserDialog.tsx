import { useState } from 'react';
import type { AdminUser } from '@mmt/contracts';
import { adminUsersApi } from '../../api/adminUsers';
import { useMutation } from '../../hooks/useMutation';
import { generateTemporaryPassword, isLongEnoughPassword } from '../../lib/temporaryPassword';
import { Dialog } from '../Dialog';
import { ErrorNotice } from '../Feedback';
import { TemporaryPasswordNotice } from './TemporaryPasswordNotice';
import { text } from '../../i18n/catalog';

/**
 * Creates a local account with an initial password the user must change at the first login.
 * After saving, the password is shown once so the administrator can hand it over.
 */
export function LocalUserDialog({
  onCreated,
  onClose,
}: {
  onCreated: (user: AdminUser) => void;
  onClose: () => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(generateTemporaryPassword);
  const [isAdmin, setIsAdmin] = useState(false);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const mutation = useMutation();
  if (createdPassword)
    return (
      <Dialog title={text.newLocalUser} onClose={onClose}>
        <TemporaryPasswordNotice password={createdPassword} />
        <footer>
          <button type="button" className="button primary" onClick={onClose}>
            {text.close}
          </button>
        </footer>
      </Dialog>
    );
  return (
    <Dialog title={text.newLocalUser} onClose={onClose} busy={mutation.pending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutation.run(async () => {
            if (!isLongEnoughPassword(password)) throw new Error(text.initialPasswordTooShort);
            const user = await adminUsersApi.create({
              username: username.trim(),
              displayName: displayName.trim(),
              ...(email.trim() ? { email: email.trim() } : {}),
              password,
              isAdmin,
            });
            setCreatedPassword(password);
            onCreated(user);
          });
        }}
      >
        <fieldset disabled={mutation.pending}>
          <label className="field">
            <span>{text.username}</span>
            <input
              required
              autoComplete="off"
              value={username}
              placeholder={text.usernamePatternHint}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{text.displayName}</span>
            <input
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{text.emailOptional}</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <div className="field">
            <label htmlFor="local-user-password">{text.initialPassword}</label>
            <div className="input-with-button">
              <input
                id="local-user-password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="button"
                onClick={() => setPassword(generateTemporaryPassword())}
              >
                {text.generatePassword}
              </button>
            </div>
            <span className="muted">{text.initialPasswordHint}</span>
          </div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(event) => setIsAdmin(event.target.checked)}
            />
            {text.makeGlobalAdmin}
          </label>
        </fieldset>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending}>
            {mutation.pending ? text.loading : text.create}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

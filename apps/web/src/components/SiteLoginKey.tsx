import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { SiteKey } from '@mmt/contracts';
import { siteComputersApi } from '../api/siteComputers';
import { useMutation } from '../hooks/useMutation';
import { ConfirmDialog } from './ConfirmDialog';
import { CopyButton } from './CopyButton';
import { ErrorNotice } from './Feedback';
import { DetailsList } from './JsonDetails';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';
import { siteComputersTextTemplates, siteKeyStatusLabels } from '../i18n/siteComputers';

/**
 * A key the launcher made for logging in on the site: the public half to add to the account's
 * authorized_keys, or a note while the launcher has not made it yet. Rotating revokes it and asks
 * the launcher for a new one; with no key yet, the request needs no confirmation.
 */
export function SiteLoginKey({
  targetId,
  siteKey,
  personal,
  accountName,
  onRequested,
}: {
  targetId: string;
  siteKey: SiteKey | null;
  /** One's own key for one's own account; otherwise the shared account's key. */
  personal: boolean;
  accountName: string;
  onRequested: () => void;
}) {
  const [isConfirming, setConfirming] = useState(false);
  const mutation = useMutation();
  const rotate = () => siteComputersApi.rotateKey(targetId, { personal });
  // A live key is revoked by the rotation, so that asks first; a first request has nothing to lose.
  const requestKey = () => {
    if (siteKey) {
      setConfirming(true);
      return;
    }
    void mutation.run(rotate).then((requested) => {
      if (requested) onRequested();
    });
  };
  const keyHint = personal
    ? siteComputersTextTemplates.sitePersonalKeyHint(accountName)
    : siteComputersTextTemplates.siteSharedKeyHint(accountName);
  return (
    <div className="site-login-key">
      {siteKey?.publicKey ? (
        <>
          <p>{keyHint}</p>
          <div className="copyable-value">
            <code>{siteKey.publicKey}</code>
            <CopyButton value={siteKey.publicKey} />
          </div>
          <DetailsList
            entries={[
              [
                text.siteKeyFingerprint,
                siteKey.fingerprint && <span className="mono">{siteKey.fingerprint}</span>,
              ],
              [text.siteKeyStatus, siteKeyStatusLabels[siteKey.status]],
              [text.siteKeyReadyAt, formatDate(siteKey.readyAt)],
            ]}
          />
        </>
      ) : (
        <p className="notice">{siteKey ? text.siteKeyRequested : text.siteKeyNone}</p>
      )}
      <ErrorNotice message={mutation.error} />
      <div className="site-computer-actions">
        <button
          type="button"
          className="button small"
          disabled={mutation.pending}
          onClick={requestKey}
        >
          <KeyRound size={14} />
          {siteKey ? text.siteKeyRotate : text.siteKeyRequest}
        </button>
      </div>
      {isConfirming && (
        <ConfirmDialog
          title={text.siteKeyRotate}
          message={text.siteKeyRotateConfirm}
          confirmLabel={text.siteKeyRotate}
          destructive
          onConfirm={rotate}
          onConfirmed={() => {
            setConfirming(false);
            onRequested();
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from './Feedback';
import { text } from '../i18n/catalog';

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const mutation = useMutation();
  return (
    <>
      <button
        type="button"
        className="button small"
        disabled={mutation.pending}
        onClick={() =>
          void mutation.run(async () => {
            if (!navigator.clipboard) throw new Error(text.copyFailed);
            await navigator.clipboard.writeText(value);
            setCopied(true);
          })
        }
      >
        <Copy size={13} />
        {copied ? text.copied : text.copy}
      </button>
      <ErrorNotice message={mutation.error} />
    </>
  );
}

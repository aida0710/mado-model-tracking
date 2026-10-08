import { useState } from 'react';
import { CopyButton } from './CopyButton';
import { buildTokenUsageSnippet, type TokenAuthentication } from '../lib/tokenUsageSnippet';
import { text } from '../i18n/catalog';

/** Environment variables for the MLflow and Mado SDKs, shown once right after a token is issued. */
export function TokenUsageSnippet({ projectId, token }: { projectId: string; token: string }) {
  const [authentication, setAuthentication] = useState<TokenAuthentication>('bearer');
  const snippet = buildTokenUsageSnippet({
    origin: window.location.origin,
    projectId,
    token,
    authentication,
  });
  return (
    <div className="field">
      <span>{text.tokenUsage}</span>
      <label className="field">
        <span>{text.tokenAuthentication}</span>
        <select
          value={authentication}
          onChange={(event) => setAuthentication(event.target.value as TokenAuthentication)}
        >
          <option value="bearer">{text.tokenAuthenticationBearer}</option>
          <option value="basic">{text.tokenAuthenticationBasic}</option>
        </select>
      </label>
      <pre className="json-view">{snippet}</pre>
      <CopyButton value={snippet} />
    </div>
  );
}

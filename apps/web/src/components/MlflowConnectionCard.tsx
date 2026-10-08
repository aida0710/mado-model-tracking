import { useState } from 'react';
import type { TokenScope } from '@mmt/contracts';
import { CopyButton } from './CopyButton';
import { TokenDialog } from '../dialogs/TokenDialog';
import { useProject } from '../hooks/useProject';
import { buildMlflowConnectionSnippets } from '../lib/tokenUsageSnippet';
import { text } from '../i18n/catalog';

// What the MLflow SDK needs to record Runs, register models and upload Artifacts (docs/mlflow.md).
// runs:write does not imply read, and set_experiment looks the experiment up before writing.
const MLFLOW_TOKEN_SCOPES: TokenScope[] = [
  'read',
  'runs:write',
  'registry:write',
  'artifacts:write',
];

/**
 * Where the MLflow 3 SDK connects for this Project. The URIs come from the address the page was
 * opened with, because the Web server forwards /api to the API.
 */
export function MlflowConnectionCard({ onTokenCreated }: { onTokenCreated: () => void }) {
  const { project, canEdit } = useProject();
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const snippets = buildMlflowConnectionSnippets({
    origin: window.location.origin,
    projectId: project.id,
  });
  return (
    <section className="settings-section mlflow-connection">
      <div className="section-heading">
        <h2>{text.mlflowConnection}</h2>
        {/* Viewers cannot hold runs:write, so the token would be refused. */}
        {canEdit && (
          <button className="button small" onClick={() => setShowTokenDialog(true)}>
            {text.mlflowConnectionIssueToken}
          </button>
        )}
      </div>
      <dl className="mlflow-connection-uris">
        <ConnectionValue name="MLFLOW_TRACKING_URI" value={snippets.trackingUri} />
        <ConnectionValue name="MLFLOW_REGISTRY_URI" value={snippets.registryUri} />
      </dl>
      <CodeSnippet label={text.mlflowConnectionEnvironment} code={snippets.bearerEnvironment} />
      <details className="mlflow-connection-more">
        <summary>{text.mlflowConnectionMore}</summary>
        <p className="muted">{text.mlflowConnectionServiceAccountHint}</p>
        <CodeSnippet label={text.mlflowConnectionPython} code={snippets.python} />
        <CodeSnippet label={text.mlflowConnectionBasic} code={snippets.basicEnvironment} />
      </details>
      {showTokenDialog && (
        <TokenDialog
          initialScopes={MLFLOW_TOKEN_SCOPES}
          onClose={() => setShowTokenDialog(false)}
          onCreated={onTokenCreated}
        />
      )}
    </section>
  );
}

function ConnectionValue({ name, value }: { name: string; value: string }) {
  return (
    <div>
      <dt className="mono">{name}</dt>
      <dd>
        <code>{value}</code>
        <CopyButton value={value} />
      </dd>
    </div>
  );
}

function CodeSnippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="mlflow-connection-snippet">
      <div className="mlflow-connection-snippet-heading">
        <span>{label}</span>
        <CopyButton value={code} />
      </div>
      <pre className="json-view">{code}</pre>
    </div>
  );
}

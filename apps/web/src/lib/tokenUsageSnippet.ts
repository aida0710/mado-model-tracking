/**
 * Shell settings that point the MLflow SDK and the Mado SDK at a Project with a new token.
 * Bearer is what both SDKs send by default; Basic is for tools that only accept a user name and
 * a password, where the password is the token and the user name is not checked.
 */
export type TokenAuthentication = 'bearer' | 'basic';

// MLFLOW_TRACKING_USERNAME must be non-empty for the SDK to send Basic; the API ignores it.
const BASIC_USERNAME_PLACEHOLDER = 'mado';

export function mlflowTrackingUri(origin: string, projectId: string): string {
  return `${origin.replace(/\/+$/, '')}/api/mlflow/projects/${encodeURIComponent(projectId)}`;
}

export function buildTokenUsageSnippet(settings: {
  origin: string;
  projectId: string;
  token: string;
  authentication: TokenAuthentication;
}): string {
  const origin = settings.origin.replace(/\/+$/, '');
  const trackingUri = mlflowTrackingUri(origin, settings.projectId);
  const lines = [
    `export MLFLOW_TRACKING_URI=${shellQuote(trackingUri)}`,
    ...(settings.authentication === 'basic'
      ? [
          `export MLFLOW_TRACKING_USERNAME=${BASIC_USERNAME_PLACEHOLDER}`,
          `export MLFLOW_TRACKING_PASSWORD=${shellQuote(settings.token)}`,
        ]
      : [`export MLFLOW_TRACKING_TOKEN=${shellQuote(settings.token)}`]),
    `export MMT_API_URL=${shellQuote(origin)}`,
    `export MMT_PROJECT_ID=${shellQuote(settings.projectId)}`,
    `export MMT_API_TOKEN=${shellQuote(settings.token)}`,
  ];
  return `${lines.join('\n')}\n`;
}

// Single quotes keep every character literal in POSIX shells.
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

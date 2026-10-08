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
  return joinLines(lines);
}

/** What the MLflow connection card on the settings page offers to copy. */
export interface MlflowConnectionSnippets {
  trackingUri: string;
  // The Model Registry lives under the same Project URL as tracking.
  registryUri: string;
  bearerEnvironment: string;
  basicEnvironment: string;
  python: string;
}

/**
 * Settings shown before any token exists, so the token is read from the terminal with `read -s`
 * instead of being written into the snippet, the shell history or the page.
 */
export function buildMlflowConnectionSnippets(settings: {
  origin: string;
  projectId: string;
}): MlflowConnectionSnippets {
  const trackingUri = mlflowTrackingUri(settings.origin, settings.projectId);
  const uriLines = [
    `export MLFLOW_TRACKING_URI=${shellQuote(trackingUri)}`,
    `export MLFLOW_REGISTRY_URI=${shellQuote(trackingUri)}`,
  ];
  return {
    trackingUri,
    registryUri: trackingUri,
    bearerEnvironment: joinLines([...uriLines, ...promptedSecretLines('MLFLOW_TRACKING_TOKEN')]),
    basicEnvironment: joinLines([
      ...uriLines,
      `export MLFLOW_TRACKING_USERNAME=${BASIC_USERNAME_PLACEHOLDER}`,
      ...promptedSecretLines('MLFLOW_TRACKING_PASSWORD'),
    ]),
    python: PYTHON_EXAMPLE,
  };
}

// The SDK reads the URI and the token from the environment, so the code itself has no settings.
const PYTHON_EXAMPLE = `import mlflow

mlflow.set_experiment("my-experiment")
with mlflow.start_run():
    mlflow.log_param("learning_rate", 2e-5)
    mlflow.log_metric("train.loss", 0.42, step=1)
`;

function promptedSecretLines(variable: string): string[] {
  return [`read -r -s -p 'API token: ' ${variable}`, `export ${variable}`];
}

function joinLines(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

// Single quotes keep every character literal in POSIX shells.
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

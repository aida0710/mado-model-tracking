import { describe, expect, it, vi } from 'vitest';
import {
  buildMlflowConnectionSnippets,
  buildTokenUsageSnippet,
  mlflowTrackingUri,
} from './tokenUsageSnippet';

const PROJECT_ID = '0b5c7a52-6b8e-4d7a-9a58-1f7d1c2b3a4e';
const TOKEN = 'mmt_AbC-123_xyz';

describe('tokenの設定例', () => {
  it('Bearerでは MLflow と Mado SDK の両方へ同じtokenとProjectのURLを設定する', () => {
    expect(
      buildTokenUsageSnippet({
        origin: 'https://mmt.example.test/',
        projectId: PROJECT_ID,
        token: TOKEN,
        authentication: 'bearer',
      }),
    ).toBe(
      [
        `export MLFLOW_TRACKING_URI=https://mmt.example.test/api/mlflow/projects/${PROJECT_ID}`,
        `export MLFLOW_TRACKING_TOKEN=${TOKEN}`,
        'export MMT_API_URL=https://mmt.example.test',
        `export MMT_PROJECT_ID=${PROJECT_ID}`,
        `export MMT_API_TOKEN=${TOKEN}`,
        '',
      ].join('\n'),
    );
  });

  it('Basicでは password に token を入れ、MLFLOW_TRACKING_TOKEN は出さない', () => {
    const snippet = buildTokenUsageSnippet({
      origin: 'http://127.0.0.1:5182',
      projectId: PROJECT_ID,
      token: TOKEN,
      authentication: 'basic',
    });
    expect(snippet).toContain('export MLFLOW_TRACKING_USERNAME=mado\n');
    expect(snippet).toContain(`export MLFLOW_TRACKING_PASSWORD=${TOKEN}\n`);
    expect(snippet).not.toContain('MLFLOW_TRACKING_TOKEN');
    expect(snippet).toContain(`export MMT_API_TOKEN=${TOKEN}\n`);
  });

  it('shellで特別な意味を持つ文字を含む値は single quote で囲む', () => {
    const snippet = buildTokenUsageSnippet({
      origin: 'http://host',
      projectId: "it's",
      token: TOKEN,
      authentication: 'bearer',
    });
    expect(snippet).toContain(`export MMT_PROJECT_ID='it'\\''s'`);
  });

  it('Project IDはURLへ埋め込むときにencodeする', () => {
    expect(mlflowTrackingUri('http://host', 'a/b')).toBe('http://host/api/mlflow/projects/a%2Fb');
  });
});

describe('MLflow 3の接続案内', () => {
  it('公開URLの末尾slashを除き、TrackingとRegistryに同じProjectのURIを使う', () => {
    const snippets = buildMlflowConnectionSnippets({
      origin: 'https://mmt.example.test//',
      projectId: PROJECT_ID,
    });
    const expected = `https://mmt.example.test/api/mlflow/projects/${PROJECT_ID}`;
    expect(snippets.trackingUri).toBe(expected);
    expect(snippets.registryUri).toBe(expected);
    expect(snippets.bearerEnvironment).toContain(`export MLFLOW_TRACKING_URI=${expected}\n`);
    expect(snippets.bearerEnvironment).toContain(`export MLFLOW_REGISTRY_URI=${expected}\n`);
  });

  it('Project IDに含まれるURLの区切り文字はencodeする', () => {
    const snippets = buildMlflowConnectionSnippets({ origin: 'http://host', projectId: 'a/b?c' });
    expect(snippets.trackingUri).toBe('http://host/api/mlflow/projects/a%2Fb%3Fc');
  });

  it('tokenは画面やshell履歴に残さず、端末から read -s で受け取る', () => {
    const snippets = buildMlflowConnectionSnippets({
      origin: 'http://host',
      projectId: PROJECT_ID,
    });
    expect(snippets.bearerEnvironment).toContain(
      "read -r -s -p 'API token: ' MLFLOW_TRACKING_TOKEN\nexport MLFLOW_TRACKING_TOKEN\n",
    );
    expect(snippets.bearerEnvironment).not.toMatch(/MLFLOW_TRACKING_TOKEN=/);
  });

  it('Basicの例は password に token を受け取り、Bearerの変数は出さない', () => {
    const { basicEnvironment } = buildMlflowConnectionSnippets({
      origin: 'http://host',
      projectId: PROJECT_ID,
    });
    expect(basicEnvironment).toContain('export MLFLOW_TRACKING_USERNAME=mado\n');
    expect(basicEnvironment).toContain(
      "read -r -s -p 'API token: ' MLFLOW_TRACKING_PASSWORD\nexport MLFLOW_TRACKING_PASSWORD\n",
    );
    expect(basicEnvironment).not.toContain('MLFLOW_TRACKING_TOKEN');
  });

  it('Pythonの例は接続先とtokenを環境変数から読み、コードに書かない', () => {
    const { python } = buildMlflowConnectionSnippets({
      origin: 'http://host',
      projectId: PROJECT_ID,
    });
    expect(python).toContain('import mlflow');
    expect(python).not.toContain('http://host');
    expect(python).not.toMatch(/token/i);
  });

  it('設定例を作るときにtokenをconsoleへ出さない', () => {
    const logged: unknown[] = [];
    const record = (...values: unknown[]) => void logged.push(...values);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(record),
    );
    try {
      buildTokenUsageSnippet({
        origin: 'http://host',
        projectId: PROJECT_ID,
        token: TOKEN,
        authentication: 'basic',
      });
      buildMlflowConnectionSnippets({ origin: 'http://host', projectId: PROJECT_ID });
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });
});

import { describe, expect, it } from 'vitest';
import { buildTokenUsageSnippet, mlflowTrackingUri } from './tokenUsageSnippet';

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

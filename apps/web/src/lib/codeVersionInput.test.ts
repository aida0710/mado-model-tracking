import { describe, expect, it } from 'vitest';
import { sifArtifact, dockerCodeVersion } from '../../tests/fixtures/execution';
import {
  buildCodeVersionInput,
  createCodeVersionValues,
  updateCodeVersionValues,
} from './codeVersionInput';

const values = {
  ...createCodeVersionValues(),
  version: 'v1',
  runtimeKind: 'docker',
  sourceKind: 'none',
  image: dockerCodeVersion.runtime.kind === 'docker' ? dockerCodeVersion.runtime.image : '',
  entrypoint: '["python", "/app/infer.py"]',
  families: 'Qwen3',
  taskTypes: ['inference'],
};
const build = (overrides = {}, artifacts = [sifArtifact]) =>
  buildCodeVersionInput({ values: { ...values, ...overrides }, artifacts, projectId: 'project' });

describe('コード版のコンテナ登録', () => {
  it('sourceなしでdigest固定imageとargvを保存しPython用requirementsを送らない', () => {
    expect(build({ requirements: 'torch' })).toMatchObject({
      runtime: dockerCodeVersion.runtime,
      source: null,
      entrypoint: ['python', '/app/infer.py'],
      requirements: [],
    });
  });
  it('コンテナに任意のinline sourceを付けられる', () => {
    expect(build({ sourceKind: 'inline', files: '{"main.py":"print(1)"}' }).source).toEqual({
      kind: 'inline',
      files: { 'main.py': 'print(1)' },
    });
  });
  it('source Artifactは保存済みの同じProjectのものだけを参照できる', () => {
    const sourceValues = { sourceKind: 'artifact', sourceArtifactId: sifArtifact.id };
    expect(build(sourceValues).source).toEqual({ kind: 'artifact', artifactId: sifArtifact.id });
    expect(() => build(sourceValues, [{ ...sifArtifact, projectId: 'another-project' }])).toThrow();
  });
  it('Pythonはsourceを必須にし依存パッケージを保存する', () => {
    expect(() => build({ runtimeKind: 'python' })).toThrow();
    expect(
      build({
        runtimeKind: 'python',
        sourceKind: 'inline',
        files: '{"main.py":"print(1)"}',
        requirements: 'numpy',
      }),
    ).toMatchObject({ runtime: { kind: 'python' }, requirements: ['numpy'] });
  });
  it.each(['singularity', 'apptainer'])('%sは保存済みSIFのIDとSHAで登録する', (kind) => {
    expect(
      build({
        runtimeKind: kind,
        sifArtifactId: sifArtifact.id,
        sha256: sifArtifact.sha256,
        workingDirectory: '/app',
      }).runtime,
    ).toEqual({
      kind,
      artifactId: sifArtifact.id,
      sha256: sifArtifact.sha256,
      workingDirectory: '/app',
    });
  });
  it('SIFが別ProjectまたはSHA不一致だと登録しない', () => {
    const sifValues = {
      runtimeKind: 'apptainer',
      sifArtifactId: sifArtifact.id,
      sha256: sifArtifact.sha256,
    };
    expect(() => build(sifValues, [{ ...sifArtifact, projectId: 'another-project' }])).toThrow();
    expect(() => build({ ...sifValues, sha256: 'c'.repeat(64) })).toThrow();
  });
  it('SIFの選択を変えると選択したArtifactのSHAが入る', () => {
    expect(
      updateCodeVersionValues({
        previous: values,
        next: { ...values, sifArtifactId: sifArtifact.id },
        artifacts: [sifArtifact],
      }).sha256,
    ).toBe(sifArtifact.sha256);
  });
  it('空の実行コマンドとJSONオブジェクトのargvを拒否する', () => {
    expect(() => build({ entrypoint: '["", "main.py"]' })).toThrow();
    expect(() => build({ entrypoint: '{"command":"python"}' })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  decodeArtifactLocation,
  nativeArtifactPath,
  parseArtifactLocation,
  validateArtifactPath,
} from '../src/mlflow/artifacts/artifactPath.js';
import { listArtifactDirectory } from '../src/mlflow/artifacts/artifactListing.js';
import { MlmodelCapture } from '../src/mlflow/artifacts/mlmodelCapture.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RUN_ID = '2d9e69a8-0e7c-401b-96d7-879a4c45ecf5';
const MODEL_ID = 'm-a1ab127ef006419c9d1d758a2d2e9a7e';

describe('MLflow Artifactの安全な相対パス', () => {
  it.each([
    '../secret',
    'directory/../secret',
    './secret',
    '/etc/passwd',
    'C:/secret',
    '//host/share',
    'directory\\secret',
    'a//b',
    'a/./b',
    'file\0name',
    'name\n.txt',
    '%2e%2e/secret',
    '%252e%252e/secret',
  ])('危険なパス%sを拒否する', (path) => {
    expect(() => validateArtifactPath(path)).toThrow();
  });

  it('日本語と空白を一度だけdecodeし、run/modelのnative pathを契約どおり生成する', () => {
    const relative = '日本語/実験 結果.txt';
    const runLocation = decodeArtifactLocation(
      `runs/${RUN_ID}/artifacts/${relative.split('/').map(encodeURIComponent).join('/')}`,
    );
    expect(runLocation).toEqual({ owner: { kind: 'run', id: RUN_ID }, path: relative });
    expect(nativeArtifactPath(runLocation)).toBe(relative);
    const modelLocation = parseArtifactLocation(`models/${MODEL_ID}/artifacts/model.pkl`);
    expect(nativeArtifactPath(modelLocation)).toBe(`models/${MODEL_ID}/model.pkl`);
    expect(() => decodeArtifactLocation(`runs/${RUN_ID}/artifacts/%252e%252e/secret`)).toThrow();
    expect(() => decodeArtifactLocation(`runs/${RUN_ID}/artifacts/%ZZ`)).toThrow();
  });

  it('一覧の空rootと末尾slashを受け付け、ファイルuploadの空pathは拒否する', () => {
    expect(validateArtifactPath('', { directory: true })).toBe('');
    expect(validateArtifactPath('directory/', { directory: true })).toBe('directory');
    expect(() => validateArtifactPath('')).toThrow();
    expect(() => validateArtifactPath('/', { directory: true })).toThrow();
    expect(() => parseArtifactLocation(`runs/${RUN_ID}/artifacts`)).toThrow();
    expect(parseArtifactLocation(`runs/${RUN_ID}/artifacts`, { directory: true }).path).toBe('');
  });

  it('直下だけを一覧にし、directoryの重複をまとめ、空ファイルのsizeを保持する', () => {
    const artifacts = [
      { path: 'empty.txt', size: 0, artifactId: 'empty' },
      { path: 'deep/a.bin', size: 10, artifactId: 'a' },
      { path: 'deep/sub/b.bin', size: 20, artifactId: 'b' },
    ];
    expect(listArtifactDirectory(artifacts, '')).toEqual([
      { path: 'deep', is_dir: true },
      { path: 'empty.txt', is_dir: false, file_size: '0' },
    ]);
    expect(listArtifactDirectory(artifacts, 'deep')).toEqual([
      { path: 'deep/a.bin', is_dir: false, file_size: '10' },
      { path: 'deep/sub', is_dir: true },
    ]);
    expect(listArtifactDirectory(artifacts, 'empty.txt')).toEqual([]);
    expect(listArtifactDirectory(artifacts, 'missing')).toEqual([]);
  });
});

describe('MLmodelの上限付きmetadata解析', () => {
  async function capture(contents: string) {
    const metadata = new MlmodelCapture();
    metadata.resume();
    await pipeline(Readable.from([Buffer.from(contents)]), metadata);
    return metadata.metadata();
  }

  it('公式MLmodelのflavorsをJSONとして保持する', async () => {
    expect(
      await capture(
        'flavors:\n  sklearn:\n    pickled_model: model.pkl\n  python_function:\n    loader_module: mlflow.sklearn\n',
      ),
    ).toEqual({
      flavors: {
        sklearn: { pickled_model: 'model.pkl' },
        python_function: { loader_module: 'mlflow.sklearn' },
      },
    });
  });

  it('巨大metadataと壊れたYAMLを解析せず、転送内容は変更しない', async () => {
    expect(await capture(`padding: ${'x'.repeat(64 * 1024)}`)).toBeNull();
    expect(await capture('flavors: [invalid')).toBeNull();
    expect(await capture('secret: first\nsecret: second')).toBeNull();
  });
});

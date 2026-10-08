import { describe, expect, it } from 'vitest';
import type { StorageBackend } from '@mmt/contracts';
import {
  buildStorageBackendCreate,
  buildStorageBackendPatch,
  createStorageBackendValues,
  updateStorageBackendValues,
} from './storageBackendInput';

const s3Values = {
  ...createStorageBackendValues(),
  name: 'minio-main',
  endpoint: 'https://minio.example.internal:9000',
  bucket: 'mmt-artifacts',
  prefix: '/team-a/',
  pathStyle: 'true',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'example-secret',
};
const savedS3: StorageBackend = {
  name: 'minio-main',
  kind: 's3',
  source: 'database',
  endpoint: 'https://minio.example.internal:9000',
  region: 'us-east-1',
  bucket: 'mmt-artifacts',
  prefix: 'team-a',
  pathStyle: true,
  signatureVersion: 'v4',
  tlsVerify: true,
  caBundleConfigured: true,
  checksumMode: 'when_required',
  multipartPartSizeBytes: 16 * 1024 * 1024,
  accessKeyId: 'AKIAEXAMPLE',
  secretConfigured: true,
  enabled: true,
};
const create = (overrides = {}) => buildStorageBackendCreate({ ...s3Values, ...overrides });

describe('保存先の作成', () => {
  it('S3の設定をbyte単位のpartサイズと正規化したprefixで送る', () => {
    expect(create()).toEqual({
      name: 'minio-main',
      kind: 's3',
      endpoint: 'https://minio.example.internal:9000',
      region: 'us-east-1',
      bucket: 'mmt-artifacts',
      prefix: 'team-a',
      pathStyle: true,
      signatureVersion: 'v4',
      tlsVerify: true,
      checksumMode: 'when_required',
      multipartPartSizeBytes: 16 * 1024 * 1024,
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      enabled: true,
    });
  });
  it('endpointはhttpかhttpsのURLだけを受け付け、空欄なら送らない', () => {
    expect(() => create({ endpoint: 'minio:9000' })).toThrow('Endpoint URL');
    expect(() => create({ endpoint: 'ftp://minio.example.internal' })).toThrow('Endpoint URL');
    expect(create({ endpoint: 'http://127.0.0.1:9000' }).endpoint).toBe('http://127.0.0.1:9000');
    expect(create({ endpoint: '' })).not.toHaveProperty('endpoint');
  });
  it('S3の命名規則に合わないbucket名を拒否する', () => {
    for (const bucket of ['ab', 'Upper-Case', 'under_score', 'a..b', '-start', '192.168.0.1'])
      expect(() => create({ bucket }), bucket).toThrow('Bucket名');
    expect(create({ bucket: 'logs.2026-10' }).bucket).toBe('logs.2026-10');
  });
  it('partサイズは5MiB未満と整数以外を拒否する', () => {
    expect(() => create({ multipartPartSizeMib: '4' })).toThrow('partサイズ');
    expect(() => create({ multipartPartSizeMib: '5.5' })).toThrow('partサイズ');
    expect(create({ multipartPartSizeMib: '5' }).multipartPartSizeBytes).toBe(5 * 1024 * 1024);
  });
  it('Access key IDだけでsecretが無い作成を拒否する', () => {
    expect(() => create({ secretAccessKey: '' })).toThrow('Secret access key');
    expect(create({ accessKeyId: '', secretAccessKey: '' })).not.toHaveProperty('accessKeyId');
  });
  it('名前は小文字英数字とハイフンだけを受け付ける', () => {
    expect(() => create({ name: 'Minio_Main' })).toThrow('名前');
    expect(() => create({ name: '-minio' })).toThrow('名前');
  });
  it('filesystemに切り替えるとS3の項目もsecretも送らない', () => {
    expect(create({ kind: 'filesystem', rootPath: '/srv/mmt-artifacts' })).toEqual({
      name: 'minio-main',
      kind: 'filesystem',
      rootPath: '/srv/mmt-artifacts',
      enabled: true,
    });
    expect(() => create({ kind: 'filesystem', rootPath: 'relative/path' })).toThrow('絶対パス');
  });
  it('S3ではfilesystemのルートディレクトリを送らない', () => {
    expect(create({ rootPath: '/srv/mmt-artifacts' })).not.toHaveProperty('rootPath');
  });
});

describe('保存先の変更', () => {
  const patch = (overrides = {}) =>
    buildStorageBackendPatch({ ...updateStorageBackendValues(savedS3), ...overrides }, savedS3);

  it('secretとCAを空欄のまま保存すると、どちらも送らず保存済みの値を保つ', () => {
    const body = patch();
    expect(body).not.toHaveProperty('secretAccessKey');
    expect(body).not.toHaveProperty('caBundle');
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('kind');
  });
  it('secretを入力したときだけ送る', () => {
    expect(patch({ secretAccessKey: 'rotated' }).secretAccessKey).toBe('rotated');
  });
  it('CAの削除を選ぶとnullを送る', () => {
    expect(patch({ clearCaBundle: 'true' }).caBundle).toBeNull();
  });
  it('消したprefixは空文字、消したendpointはnullで送り、保存済みの値を消す', () => {
    expect(patch({ prefix: '' }).prefix).toBe('');
    expect(patch({ endpoint: '' }).endpoint).toBeNull();
  });
  it('Access key IDを消すとnullを送り、入力済みのsecretも送らない', () => {
    const body = patch({ accessKeyId: '', secretAccessKey: 'typed-by-mistake' });
    expect(body.accessKeyId).toBeNull();
    expect(body).not.toHaveProperty('secretAccessKey');
  });
  it('PEMでないCA証明書を拒否し、PEMなら送る', () => {
    expect(() => patch({ caBundle: 'not a certificate' })).toThrow('PEM');
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(patch({ caBundle: pem }).caBundle).toBe(pem);
  });
  it('保存済みsecretが無いままAccess key IDを付ける変更を拒否する', () => {
    expect(() =>
      buildStorageBackendPatch(
        { ...updateStorageBackendValues(savedS3) },
        { ...savedS3, secretConfigured: false },
      ),
    ).toThrow('Secret access key');
  });
  it('保存済みのpartサイズをMiBで表示し、そのまま保存すると同じbyte数を送る', () => {
    expect(updateStorageBackendValues(savedS3).multipartPartSizeMib).toBe('16');
    expect(patch().multipartPartSizeBytes).toBe(savedS3.multipartPartSizeBytes);
  });
  it('filesystemの変更ではS3の項目を送らない', () => {
    const filesystem: StorageBackend = {
      ...savedS3,
      name: 'local-disk',
      kind: 'filesystem',
      rootPath: '/srv/a',
    };
    expect(
      buildStorageBackendPatch(
        { ...updateStorageBackendValues(filesystem), rootPath: '/srv/b' },
        filesystem,
      ),
    ).toEqual({ rootPath: '/srv/b', enabled: true });
  });
});

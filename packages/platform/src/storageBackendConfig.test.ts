import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createS3ArtifactStore } from './s3ArtifactStore.js';
import { createS3Client, s3ClientConfig } from './s3ClientFactory.js';
import {
  DEFAULT_MULTIPART_PART_SIZE_BYTES,
  isValidStorageBackendName,
  MAX_MULTIPART_PART_SIZE_BYTES,
  normalizeStorageBackendConfig,
  storageLocationChanged,
  StorageBackendConfigError,
  type S3BackendConfig,
} from './storageBackendConfig.js';

const MIB = 1024 * 1024;
const s3Input = { kind: 's3' as const, bucket: 'mmt-artifacts' };

function configError(run: () => unknown): StorageBackendConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof StorageBackendConfigError) return error;
    throw error;
  }
  throw new Error('expected a StorageBackendConfigError');
}

describe('保存先の設定検証', () => {
  it('S3は省略した項目に既定値（v4・TLS検証・WHEN_REQUIRED・8MiB）を入れる', () => {
    expect(normalizeStorageBackendConfig(s3Input)).toEqual({
      kind: 's3',
      region: 'us-east-1',
      bucket: 'mmt-artifacts',
      prefix: '',
      pathStyle: false,
      signatureVersion: 'v4',
      tlsVerify: true,
      checksumMode: 'when_required',
      multipartPartSizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
    });
  });

  it('prefixの前後と重複したスラッシュを除き、endpoint末尾のスラッシュを落とす', () => {
    const config = normalizeStorageBackendConfig({
      ...s3Input,
      prefix: '/team//artifacts/',
      endpoint: 'https://minio.internal:9000/',
    }) as S3BackendConfig;
    expect(config.prefix).toBe('team/artifacts');
    expect(config.endpoint).toBe('https://minio.internal:9000');
  });

  it('URLでないendpoint、認証情報入りendpoint、不正なbucket名とprefixを拒否する', () => {
    expect(
      configError(() => normalizeStorageBackendConfig({ ...s3Input, endpoint: 'minio' })).field,
    ).toBe('endpoint');
    expect(
      configError(() =>
        normalizeStorageBackendConfig({ ...s3Input, endpoint: 'https://user:pass@minio.internal' }),
      ).field,
    ).toBe('endpoint');
    expect(
      configError(() => normalizeStorageBackendConfig({ ...s3Input, endpoint: 'ftp://minio' }))
        .field,
    ).toBe('endpoint');
    expect(
      configError(() => normalizeStorageBackendConfig({ kind: 's3', bucket: 'Bad_Bucket' })).field,
    ).toBe('bucket');
    expect(
      configError(() => normalizeStorageBackendConfig({ ...s3Input, prefix: 'a/../b' })).field,
    ).toBe('prefix');
  });

  it('part sizeは5MiB未満と上限超えを拒否し、5MiBちょうどは受け付ける', () => {
    expect(
      configError(() =>
        normalizeStorageBackendConfig({ ...s3Input, multipartPartSizeBytes: 5 * MIB - 1 }),
      ).field,
    ).toBe('multipartPartSizeBytes');
    expect(
      configError(() =>
        normalizeStorageBackendConfig({
          ...s3Input,
          multipartPartSizeBytes: MAX_MULTIPART_PART_SIZE_BYTES + 1,
        }),
      ).field,
    ).toBe('multipartPartSizeBytes');
    expect(
      normalizeStorageBackendConfig({ ...s3Input, multipartPartSizeBytes: 5 * MIB }),
    ).toMatchObject({ multipartPartSizeBytes: 5 * MIB });
  });

  it('署名v2は専用のコードで拒否する', () => {
    expect(
      configError(() => normalizeStorageBackendConfig({ ...s3Input, signatureVersion: 'v2' })).code,
    ).toBe('storage_signature_unsupported');
  });

  it('filesystemは絶対パスだけを受け付け、..を含むパスを拒否する', () => {
    expect(normalizeStorageBackendConfig({ kind: 'filesystem', rootPath: '/srv/mmt/' })).toEqual({
      kind: 'filesystem',
      rootPath: '/srv/mmt/',
    });
    expect(
      configError(() => normalizeStorageBackendConfig({ kind: 'filesystem', rootPath: 'var/a' }))
        .field,
    ).toBe('rootPath');
    expect(
      configError(() =>
        normalizeStorageBackendConfig({ kind: 'filesystem', rootPath: '/srv/../etc' }),
      ).field,
    ).toBe('rootPath');
  });

  it('保存先名は小文字英数字とハイフンだけ', () => {
    expect(isValidStorageBackendName('archive-2')).toBe(true);
    expect(isValidStorageBackendName('Archive')).toBe(false);
    expect(isValidStorageBackendName('-archive')).toBe(false);
    expect(isValidStorageBackendName('a'.repeat(64))).toBe(false);
  });

  it('bucket・endpoint・prefix・種類の変更だけを保存場所の変更として扱う', () => {
    const current = normalizeStorageBackendConfig(s3Input);
    expect(
      storageLocationChanged(
        current,
        normalizeStorageBackendConfig({ ...s3Input, region: 'ap-northeast-1' }),
      ),
    ).toBe(false);
    expect(
      storageLocationChanged(
        current,
        normalizeStorageBackendConfig({ ...s3Input, prefix: 'other' }),
      ),
    ).toBe(true);
    expect(
      storageLocationChanged(
        current,
        normalizeStorageBackendConfig({ kind: 'filesystem', rootPath: '/srv' }),
      ),
    ).toBe(true);
  });
});

describe('S3 clientの設定', () => {
  const base = normalizeStorageBackendConfig(s3Input) as S3BackendConfig;

  it('checksumModeをSDKのrequestChecksumCalculationとresponseChecksumValidationへ反映する', async () => {
    expect(s3ClientConfig({ config: base })).toMatchObject({
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    const client = createS3Client({ config: { ...base, checksumMode: 'when_supported' } });
    try {
      expect(await client.config.requestChecksumCalculation()).toBe('WHEN_SUPPORTED');
      expect(await client.config.responseChecksumValidation()).toBe('WHEN_SUPPORTED');
    } finally {
      client.destroy();
    }
  });

  it('path-style、TLS検証の無効化とCAをclientへ渡す', () => {
    const settings = s3ClientConfig({
      config: { ...base, pathStyle: true, tlsVerify: false, endpoint: 'https://minio.internal' },
      caBundle: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n',
    });
    expect(settings.forcePathStyle).toBe(true);
    expect(settings.endpoint).toBe('https://minio.internal');
    expect(settings.requestHandler).toMatchObject({
      httpsAgent: { rejectUnauthorized: false, ca: expect.stringContaining('BEGIN CERTIFICATE') },
    });
  });
});

describe('S3 storeのpart size', () => {
  it('単一putは設定したpart sizeでmultipartに分割する', async () => {
    const uploadedPartSizes: number[] = [];
    // Records commands instead of talking to S3; only the calls put() makes are answered.
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        switch (command.constructor.name) {
          case 'CreateMultipartUploadCommand':
            return { UploadId: 'upload-1' };
          case 'UploadPartCommand': {
            let size = 0;
            for await (const chunk of command.input.Body as Readable) size += chunk.length;
            uploadedPartSizes.push(size);
            return { ETag: `"etag-${uploadedPartSizes.length}"` };
          }
          case 'CompleteMultipartUploadCommand':
            return {};
          default:
            throw new Error(`unexpected ${command.constructor.name}`);
        }
      },
    } as unknown as S3Client;
    const store = createS3ArtifactStore({
      client,
      bucket: 'mmt-artifacts',
      multipartPartSizeBytes: 5 * MIB,
    });
    const chunks = Array.from({ length: 12 }, () => Buffer.alloc(MIB, 1));
    const stored = await store.put({
      key: 'p/a/content',
      body: Readable.from(chunks),
      mimeType: 'application/octet-stream',
    });
    expect(stored.size).toBe(12 * MIB);
    expect(uploadedPartSizes.sort((left, right) => right - left)).toEqual([
      5 * MIB,
      5 * MIB,
      2 * MIB,
    ]);
  });
});

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { StorageTestResult, StorageTestStep } from '@mmt/contracts';
import { ArtifactNotFoundError, type ArtifactStore } from '@mmt/platform';
import { StorageBackendUnavailableError } from './artifactStoreRegistry.js';

// Connection tests write only below this prefix, so leftovers are easy to find and remove.
const CONNECTION_TEST_PREFIX = 'mmt-connection-test';
// Big enough for a meaningful range read, small enough to be cheap on any backend.
const CONNECTION_TEST_BYTES = 64;
const CONNECTION_TEST_RANGE = { start: 8, end: 15 };
const SKIPPED_STEP_ERROR = '前の段階が失敗したため実行していません';

/** Error names, HTTP status and Node error codes only: SDK messages may echo signed headers. */
function describeStorageFailure(error: unknown): string {
  if (error instanceof ArtifactNotFoundError) return 'オブジェクトが見つかりません';
  if (error instanceof StorageBackendUnavailableError)
    return error.reason === 'secret_key_missing'
      ? 'MMT_STORAGE_SECRET_KEYが設定されていないためsecretを読めません'
      : '保存されたsecretを現在の鍵で読めません';
  const name = error instanceof Error && /^[A-Za-z0-9_.]+$/.test(error.name) ? error.name : 'Error';
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const code = (error as { code?: unknown })?.code;
  return [
    name,
    status ? `(HTTP ${status})` : null,
    typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : null,
  ]
    .filter(Boolean)
    .join(' ');
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

class ConnectionTestMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionTestMismatch';
  }
}
function expectBytes(actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) throw new ConnectionTestMismatch('読み出した内容が一致しません');
}

/**
 * Writes, reads, range-reads and deletes one probe object. Each step reports separately so an
 * administrator can tell missing write permission from a broken range read.
 */
export async function runConnectionTest(
  openStore: () => ArtifactStore,
): Promise<StorageTestResult> {
  const key = `${CONNECTION_TEST_PREFIX}/${randomUUID()}/probe.bin`;
  const probe = randomBytes(CONNECTION_TEST_BYTES);
  let store: ArtifactStore | null = null;
  const stepActions: [StorageTestStep['name'], (store: ArtifactStore) => Promise<void>][] = [
    [
      'put',
      async (target) => {
        const stored = await target.put({
          key,
          body: Readable.from([probe]),
          mimeType: 'application/octet-stream',
        });
        if (stored.sha256 !== createHash('sha256').update(probe).digest('hex'))
          throw new ConnectionTestMismatch('書き込んだ内容のSHA-256が一致しません');
      },
    ],
    ['get', async (target) => expectBytes(await readAll((await target.read({ key })).body), probe)],
    [
      'range',
      async (target) => {
        const { start, end } = CONNECTION_TEST_RANGE;
        const part = await target.read({ key, range: `bytes=${start}-${end}` });
        if (part.status !== 206) throw new ConnectionTestMismatch('Rangeの部分応答になりません');
        expectBytes(await readAll(part.body), probe.subarray(start, end + 1));
      },
    ],
    [
      'delete',
      async (target) => {
        await target.remove(key);
        const deleted = await target.read({ key }).then(
          () => false,
          (error: unknown) => error instanceof ArtifactNotFoundError,
        );
        if (!deleted) throw new ConnectionTestMismatch('削除後もオブジェクトが読めます');
      },
    ],
  ];
  const steps: StorageTestStep[] = [];
  let failed = false;
  let written = false;
  for (const [name, action] of stepActions) {
    // Cleanup still runs after a failed read so the probe object does not stay behind.
    const mustRun = !failed || (name === 'delete' && written);
    if (!mustRun) {
      steps.push({ name, ok: false, error: SKIPPED_STEP_ERROR });
      continue;
    }
    try {
      store ??= openStore();
      await action(store);
      if (name === 'put') written = true;
      steps.push({ name, ok: true });
    } catch (error) {
      if (name === 'put') written = !(error instanceof StorageBackendUnavailableError);
      failed = true;
      steps.push({
        name,
        ok: false,
        error:
          error instanceof ConnectionTestMismatch ? error.message : describeStorageFailure(error),
      });
    }
  }
  return { steps };
}

/**
 * Verify the S3 Artifact store against a real bucket (or a local emulator) inside a dedicated
 * prefix, then remove everything it wrote. Bucket names, endpoints, object keys and credentials
 * never reach the result file or the console.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import pg from 'pg';
import {
  ArtifactNotFoundError,
  ArtifactRangeError,
  createS3ArtifactStore,
  createS3Client,
  type ArtifactStore,
} from '@mmt/platform';
import { findStorageBackendRow } from '../apps/api/src/repositories/storageBackendRepository.js';
import { decryptSecret, parseSecretKey } from '../apps/api/src/security/secretEncryption.js';
import { storageSecretContext } from '../apps/api/src/services/artifactStoreRegistry.js';

const MIB = 1024 * 1024;
// Above 16 MiB so the store must send at least two multipart parts plus an uneven last part.
const MULTIPART_OBJECT_BYTES = 17 * MIB + 123;
// The platform store currently uploads 8 MiB parts; a range around this offset spans two parts.
const PART_BOUNDARY_OFFSET = 8 * MIB;
// Two full parts guarantee the upload is already a server-side multipart upload when it breaks.
const INTERRUPTED_UPLOAD_BYTES = 17 * MIB;
const STREAM_CHUNK_BYTES = MIB;
// Real endpoints may take a moment to list a started upload or drop an aborted one.
const MULTIPART_LISTING_DEADLINE_MS = 30_000;
const MULTIPART_POLL_INTERVAL_MS = 200;
// Running against a real bucket writes and deletes objects, so the operator must opt in.
const CONFIRM_VALUE = 'write-and-delete';
const DEFAULT_OUTSIDE_PREFIX = 'mmt-verification-outside-prefix';
const INTERRUPTION_MESSAGE = 'verification interrupted the upload stream';

/** Where to verify: the environment S3 backend or a DB-configured backend chosen by name. */
interface S3VerificationTarget {
  client: S3Client;
  bucket: string;
  /** Prefix the application is allowed to use (S3_PREFIX). May be empty. */
  basePrefix: string;
  /** Prefix outside basePrefix used to check that IAM denies access beyond it. */
  outsidePrefix: string | null;
  /** Non-secret facts that are safe to write to the result file. */
  description: Record<string, string | boolean>;
}
interface VerificationContext {
  target: S3VerificationTarget;
  date: string;
  runId: string;
  /** Full object-key prefix of this run; every object this script writes lives below it. */
  runPrefix: string;
  /** Store rooted at runPrefix, built only through the public platform API. */
  store: ArtifactStore;
}
type StageStatus = 'passed' | 'warning' | 'skipped' | 'failed';
interface StageOutcome {
  status: Exclude<StageStatus, 'failed'>;
  details: Record<string, unknown>;
}
interface VerificationStage {
  name: string;
  run(context: VerificationContext): Promise<StageOutcome>;
}
interface StageResult {
  name: string;
  status: StageStatus;
  durationMs: number;
  details: Record<string, unknown>;
}

function joinKey(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}
function tokyoDate(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function chunked(bytes: Buffer): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += STREAM_CHUNK_BYTES)
    chunks.push(bytes.subarray(offset, offset + STREAM_CHUNK_BYTES));
  return Readable.from(chunks);
}

/** SDK messages can echo bucket names, keys or account ARNs, so only these fields are kept. */
function describeError(error: unknown): {
  error: string;
  httpStatus: number | null;
  code: string | null;
} {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  // Node network codes such as ECONNREFUSED carry no host or credential information.
  const code = (error as { code?: unknown })?.code;
  return {
    error: name,
    httpStatus: status ?? null,
    code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : null,
  };
}
function isAccessDenied(error: unknown): boolean {
  const { error: name, httpStatus } = describeError(error);
  return httpStatus === 403 || name === 'AccessDenied';
}
function isNotFound(error: unknown): boolean {
  const { error: name, httpStatus } = describeError(error);
  return httpStatus === 404 || name === 'NoSuchKey' || name === 'NotFound';
}

/** Mirrors createArtifactStoresFromEnv so the check exercises the same client settings. */
function readS3TargetFromEnv(env: NodeJS.ProcessEnv): S3VerificationTarget {
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is not configured');
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
    throw new Error('S3 credential fields must be configured together');
  const basePrefix = joinKey(env.S3_PREFIX ?? '');
  const region = env.S3_REGION ?? 'us-east-1';
  const forcePathStyle = env.S3_FORCE_PATH_STYLE === 'true';
  const client = new S3Client({
    region,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle,
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  const outsidePrefix = outsidePrefixFromEnv(env);
  return {
    client,
    bucket,
    basePrefix,
    outsidePrefix,
    description: {
      source: 'env',
      endpoint: env.S3_ENDPOINT ? 'custom' : 'aws-default',
      region,
      forcePathStyle,
      basePrefixConfigured: Boolean(basePrefix),
      staticCredentials: Boolean(env.S3_ACCESS_KEY_ID),
      outsidePrefixCheck: outsidePrefix !== null,
    },
  };
}

function outsidePrefixFromEnv(env: NodeJS.ProcessEnv): string | null {
  return env.MMT_VERIFY_S3_SKIP_OUTSIDE_PREFIX === 'true'
    ? null
    : joinKey(env.MMT_VERIFY_S3_OUTSIDE_PREFIX ?? DEFAULT_OUTSIDE_PREFIX);
}

/**
 * Builds the client the API builds for a DB backend (s3ClientFactory), decrypting the secret with
 * MMT_STORAGE_SECRET_KEY. Only non-secret facts reach the description.
 */
async function readS3TargetFromDatabase(
  env: NodeJS.ProcessEnv,
  backendName: string,
): Promise<S3VerificationTarget> {
  const databaseUrl = env.MMT_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('MMT_DATABASE_URL is required to read a DB backend');
  const database = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const row = await findStorageBackendRow(database, backendName);
    if (!row) throw new Error('The named storage backend does not exist in the database');
    if (row.config.kind !== 's3') throw new Error('The named storage backend is not S3');
    let credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
    if (row.accessKeyId && row.secretEncrypted && row.secretKeyId) {
      if (!env.MMT_STORAGE_SECRET_KEY)
        throw new Error('MMT_STORAGE_SECRET_KEY is required to decrypt the backend secret');
      credentials = {
        accessKeyId: row.accessKeyId,
        secretAccessKey: decryptSecret({
          key: parseSecretKey(env.MMT_STORAGE_SECRET_KEY),
          encrypted: { keyId: row.secretKeyId, payload: row.secretEncrypted },
          context: storageSecretContext(row.name),
        }),
      };
    }
    const { config } = row;
    const outsidePrefix = outsidePrefixFromEnv(env);
    return {
      client: createS3Client({
        config,
        ...(credentials ? { credentials } : {}),
        ...(row.caBundle ? { caBundle: row.caBundle } : {}),
      }),
      bucket: config.bucket,
      basePrefix: config.prefix,
      outsidePrefix,
      description: {
        source: 'database',
        backend: row.name,
        endpoint: config.endpoint ? 'custom' : 'aws-default',
        region: config.region,
        forcePathStyle: config.pathStyle,
        signatureVersion: config.signatureVersion,
        checksumMode: config.checksumMode,
        tlsVerify: config.tlsVerify,
        caBundleConfigured: row.caBundle !== null,
        basePrefixConfigured: Boolean(config.prefix),
        staticCredentials: Boolean(credentials),
        outsidePrefixCheck: outsidePrefix !== null,
      },
    };
  } finally {
    await database.end();
  }
}

function createVerificationContext(
  target: S3VerificationTarget,
  now: Date,
): VerificationContext {
  const date = tokyoDate(now);
  const runId = randomUUID();
  const runPrefix = joinKey(target.basePrefix, 'verification', date, runId);
  return {
    target,
    date,
    runId,
    runPrefix,
    store: createS3ArtifactStore({
      client: target.client,
      bucket: target.bucket,
      prefix: runPrefix,
    }),
  };
}

async function listRunUploads(context: VerificationContext, key: string) {
  const listing = await context.target.client.send(
    new ListMultipartUploadsCommand({ Bucket: context.target.bucket, Prefix: key }),
  );
  return listing.Uploads ?? [];
}
async function headPartCount(context: VerificationContext, key: string): Promise<number | null> {
  const head = await context.target.client.send(
    new HeadObjectCommand({ Bucket: context.target.bucket, Key: key }),
  );
  // Multipart objects carry an ETag of the form "<md5>-<part count>" on S3 and compatibles.
  const match = /-(\d+)"?$/.exec(head.ETag ?? '');
  return match ? Number(match[1]) : null;
}
async function expectRead(
  store: ArtifactStore,
  key: string,
  range: string,
  expected: { bytes: Buffer; contentRange: string },
): Promise<void> {
  const selected = await store.read({ key, range });
  assert.equal(selected.status, 206, `${range} must return a partial response`);
  assert.equal(selected.contentRange, expected.contentRange, `${range} content range`);
  assert.equal(selected.size, expected.bytes.length, `${range} size`);
  assert.ok((await readAll(selected.body)).equals(expected.bytes), `${range} bytes must match`);
}
async function expectNotFound(store: ArtifactStore, key: string): Promise<void> {
  await assert.rejects(store.read({ key }), ArtifactNotFoundError);
}

async function verifySmallObject(context: VerificationContext): Promise<StageOutcome> {
  const key = 'small.bin';
  const bytes = randomBytes(4096 + 17);
  const written = await context.store.put({
    key,
    body: Readable.from([bytes]),
    mimeType: 'application/octet-stream',
  });
  assert.deepEqual(written, { size: bytes.length, sha256: sha256(bytes) });
  const whole = await context.store.read({ key });
  assert.equal(whole.status, 200);
  assert.equal(whole.totalSize, bytes.length);
  assert.ok((await readAll(whole.body)).equals(bytes), 'full read must match');
  return { status: 'passed', details: { bytes: bytes.length, sha256Matched: true } };
}

async function verifyRangeReads(context: VerificationContext): Promise<StageOutcome> {
  const key = 'range.bin';
  const bytes = randomBytes(64 * 1024 + 5);
  const total = bytes.length;
  await context.store.put({ key, body: Readable.from([bytes]), mimeType: 'audio/wav' });
  await expectRead(context.store, key, 'bytes=100-199', {
    bytes: bytes.subarray(100, 200),
    contentRange: `bytes 100-199/${total}`,
  });
  await expectRead(context.store, key, 'bytes=-500', {
    bytes: bytes.subarray(total - 500),
    contentRange: `bytes ${total - 500}-${total - 1}/${total}`,
  });
  await expectRead(context.store, key, `bytes=${total - 10}-`, {
    bytes: bytes.subarray(total - 10),
    contentRange: `bytes ${total - 10}-${total - 1}/${total}`,
  });
  // An end beyond the object is clamped, as browsers request when seeking media.
  await expectRead(context.store, key, `bytes=${total - 3}-${total + 1000}`, {
    bytes: bytes.subarray(total - 3),
    contentRange: `bytes ${total - 3}-${total - 1}/${total}`,
  });
  await assert.rejects(context.store.read({ key, range: `bytes=${total}-` }), ArtifactRangeError);
  return {
    status: 'passed',
    details: {
      bytes: total,
      checked: ['explicit', 'suffix', 'open-ended', 'clamped-end', 'unsatisfiable'],
    },
  };
}

async function verifyMultipartObject(context: VerificationContext): Promise<StageOutcome> {
  const key = 'multipart.bin';
  const bytes = randomBytes(MULTIPART_OBJECT_BYTES);
  const written = await context.store.put({
    key,
    body: chunked(bytes),
    mimeType: 'application/octet-stream',
  });
  assert.deepEqual(written, { size: bytes.length, sha256: sha256(bytes) });
  const whole = await context.store.read({ key });
  assert.equal(sha256(await readAll(whole.body)), written.sha256, 'downloaded digest must match');
  await expectRead(
    context.store,
    key,
    `bytes=${PART_BOUNDARY_OFFSET - 8}-${PART_BOUNDARY_OFFSET + 7}`,
    {
      bytes: bytes.subarray(PART_BOUNDARY_OFFSET - 8, PART_BOUNDARY_OFFSET + 8),
      contentRange: `bytes ${PART_BOUNDARY_OFFSET - 8}-${PART_BOUNDARY_OFFSET + 7}/${bytes.length}`,
    },
  );
  await expectRead(context.store, key, 'bytes=-1024', {
    bytes: bytes.subarray(bytes.length - 1024),
    contentRange: `bytes ${bytes.length - 1024}-${bytes.length - 1}/${bytes.length}`,
  });
  const partCount = await headPartCount(context, joinKey(context.runPrefix, key));
  const details = { bytes: bytes.length, sha256Matched: true, partCount };
  // Some S3-compatible services rewrite ETags, so a missing part count is reported, not failed.
  if (partCount === null)
    return { status: 'warning', details: { ...details, etagHasPartCount: false } };
  assert.ok(partCount >= 2, 'object above 16 MiB must be stored with multipart upload');
  return { status: 'passed', details };
}

type UploadPollResult = { satisfied: boolean; attempts: number; elapsedMs: number } | 'list-denied';
/** Polls ListMultipartUploads for one key until its pending-upload count satisfies isDone. */
async function pollPendingUploads(
  context: VerificationContext,
  key: string,
  isDone: (pendingUploads: number) => boolean,
): Promise<UploadPollResult> {
  const startedAt = Date.now();
  const deadline = startedAt + MULTIPART_LISTING_DEADLINE_MS;
  for (let attempts = 1; ; attempts += 1) {
    try {
      if (isDone((await listRunUploads(context, key)).length))
        return { satisfied: true, attempts, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
      return 'list-denied';
    }
    if (Date.now() >= deadline)
      return { satisfied: false, attempts, elapsedMs: Date.now() - startedAt };
    await delay(MULTIPART_POLL_INTERVAL_MS);
  }
}

async function verifyInterruptedMultipartCleanup(
  context: VerificationContext,
): Promise<StageOutcome> {
  const key = 'interrupted.bin';
  const fullKey = joinKey(context.runPrefix, key);
  let inProgress: UploadPollResult | null = null;
  const body = Readable.from(
    (async function* () {
      for (let sent = 0; sent < INTERRUPTED_UPLOAD_BYTES; sent += STREAM_CHUNK_BYTES)
        yield randomBytes(STREAM_CHUNK_BYTES);
      inProgress = await pollPendingUploads(context, fullKey, (pending) => pending > 0);
      throw new Error(INTERRUPTION_MESSAGE);
    })(),
  );
  await assert.rejects(
    context.store.put({ key, body, mimeType: 'application/octet-stream' }),
    (error: Error) => error.message === INTERRUPTION_MESSAGE,
  );
  await expectNotFound(context.store, key);
  const observed = inProgress as UploadPollResult | null;
  if (observed === 'list-denied')
    return {
      status: 'warning',
      details: { listMultipartUploads: 'denied', partialObjectVisible: false },
    };
  const drained = await pollPendingUploads(context, fullKey, (pending) => pending === 0);
  assert.ok(
    drained !== 'list-denied' && drained.satisfied,
    'aborted upload must not remain in ListMultipartUploads',
  );
  // A pending upload right after put() rejects means the abort runs in the background; if the
  // process exits in that window the parts stay billed until a bucket lifecycle rule removes them.
  const abortFinishedBeforeReject = drained.attempts === 1;
  const details = {
    sentBytesBeforeAbort: INTERRUPTED_UPLOAD_BYTES,
    observedInProgressUpload: observed?.satisfied ?? false,
    abortFinishedBeforeReject,
    pendingUploadGoneAfterMs: drained.elapsedMs,
    partialObjectVisible: false,
  };
  const clean = details.observedInProgressUpload && abortFinishedBeforeReject;
  return { status: clean ? 'passed' : 'warning', details };
}

/**
 * IAM should confine the application to basePrefix. An allowed write outside it is a warning,
 * not a failure: the operator decides whether the broader grant is acceptable.
 */
async function verifyOutsidePrefixDenied(
  context: VerificationContext,
): Promise<StageOutcome> {
  const { client, bucket, basePrefix, outsidePrefix } = context.target;
  if (outsidePrefix === null) return { status: 'skipped', details: { reason: 'disabled' } };
  if (!basePrefix) return { status: 'skipped', details: { reason: 'S3_PREFIX is empty' } };
  if (outsidePrefix === basePrefix || outsidePrefix.startsWith(`${basePrefix}/`))
    throw new Error('Outside prefix must not be inside S3_PREFIX');
  const outsideKey = joinKey(outsidePrefix, context.date, context.runId, 'outside.bin');
  let put: 'denied' | 'allowed';
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: outsideKey, Body: 'outside' }));
    put = 'allowed';
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    put = 'denied';
  }
  // When the write was denied the key is missing; S3 answers 403 for a missing key only when
  // the caller lacks read or list access there, so 404 means reads are not confined.
  let get: 'denied' | 'allowed' | 'not-found';
  try {
    await readAll(
      (await client.send(new GetObjectCommand({ Bucket: bucket, Key: outsideKey })))
        .Body as Readable,
    );
    get = 'allowed';
  } catch (error) {
    if (isAccessDenied(error)) get = 'denied';
    else if (isNotFound(error)) get = 'not-found';
    else throw error;
  }
  let outsideObjectRemoved: boolean | null = null;
  if (put === 'allowed') {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: outsideKey }));
    outsideObjectRemoved = true;
  }
  // A 403 on a missing key may come from a missing list grant alone, so record what Get targeted.
  const getTarget = put === 'allowed' ? 'written-object' : 'missing-key';
  const details = { put, get, getTarget, outsideObjectRemoved };
  return { status: put === 'denied' && get === 'denied' ? 'passed' : 'warning', details };
}

async function verifyRemove(context: VerificationContext): Promise<StageOutcome> {
  const key = 'remove.bin';
  await context.store.put({
    key,
    body: Readable.from([randomBytes(1024)]),
    mimeType: 'application/octet-stream',
  });
  await context.store.remove(key);
  await expectNotFound(context.store, key);
  // Deleting a missing object must stay idempotent so retried deletions do not fail.
  await context.store.remove(key);
  return { status: 'passed', details: { removedObjectReadable: false, repeatRemove: 'ok' } };
}

/** Removes every object and pending upload below runPrefix, then confirms the prefix is empty. */
async function cleanUpRunPrefix(context: VerificationContext): Promise<StageOutcome> {
  const { client, bucket } = context.target;
  const Prefix = `${context.runPrefix}/`;
  try {
    let abortedUploads = 0;
    for (const upload of (
      await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix }))
    ).Uploads ?? []) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
      abortedUploads += 1;
    }
    let deletedObjects = 0;
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix, ContinuationToken: continuationToken }),
      );
      const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key }));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        deletedObjects += keys.length;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    const after = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix, MaxKeys: 1 }),
    );
    assert.equal(after.KeyCount ?? 0, 0, 'verification prefix must be empty after cleanup');
    return { status: 'passed', details: { abortedUploads, deletedObjects, remainingObjects: 0 } };
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    // Without list permission, each stage already removed its own objects through the store.
    return { status: 'warning', details: { listing: 'denied', ...describeError(error) } };
  }
}

/** Ordered checks. Upload-session resume checks join here once that API lands (W2). */
const VERIFICATION_STAGES: VerificationStage[] = [
  { name: 'small-put-get', run: verifySmallObject },
  { name: 'range-and-suffix-range', run: verifyRangeReads },
  { name: 'multipart-over-16mib', run: verifyMultipartObject },
  { name: 'interrupted-multipart-cleanup', run: verifyInterruptedMultipartCleanup },
  { name: 'outside-prefix-denied', run: verifyOutsidePrefixDenied },
  { name: 'remove', run: verifyRemove },
];
const CLEANUP_STAGE: VerificationStage = { name: 'cleanup-run-prefix', run: cleanUpRunPrefix };

async function runStage(
  stage: VerificationStage,
  context: VerificationContext,
): Promise<StageResult> {
  const startedAt = Date.now();
  try {
    const outcome = await stage.run(context);
    return { name: stage.name, ...outcome, durationMs: Date.now() - startedAt };
  } catch (error) {
    // Assertion messages are written by this script; SDK errors are reduced to name and status.
    const details =
      error instanceof assert.AssertionError
        ? { assertion: error.message }
        : describeError(error);
    return { name: stage.name, status: 'failed', details, durationMs: Date.now() - startedAt };
  }
}

async function runS3Verification(target: S3VerificationTarget, now = new Date()) {
  const context = createVerificationContext(target, now);
  const stages: StageResult[] = [];
  try {
    for (const stage of VERIFICATION_STAGES) {
      const result = await runStage(stage, context);
      stages.push(result);
      console.log(`${result.status.padEnd(7)} ${result.name} (${result.durationMs}ms)`);
    }
  } finally {
    const cleanup = await runStage(CLEANUP_STAGE, context);
    stages.push(cleanup);
    console.log(`${cleanup.status.padEnd(7)} ${cleanup.name} (${cleanup.durationMs}ms)`);
  }
  const count = (status: StageStatus) => stages.filter((stage) => stage.status === status).length;
  return {
    checkedAt: now.toISOString(),
    date: context.date,
    runId: context.runId,
    target: target.description,
    summary: {
      passed: count('passed'),
      warning: count('warning'),
      skipped: count('skipped'),
      failed: count('failed'),
    },
    stages,
  };
}

async function main(): Promise<void> {
  const envFile = process.env.MMT_VERIFY_ENV_FILE ?? '.env';
  // Values already in the environment win over the file, so an emulator run can override .env.
  if (envFile !== 'none' && existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.MMT_VERIFY_S3_CONFIRM !== CONFIRM_VALUE) {
    console.error(
      `Set MMT_VERIFY_S3_CONFIRM=${CONFIRM_VALUE} after agreeing on the bucket, prefix ` +
        'and the scope this script may write and delete.',
    );
    process.exitCode = 2;
    return;
  }
  // MMT_VERIFY_S3_BACKEND names a backend stored by an administrator; otherwise S3_* is used.
  const backendName = process.env.MMT_VERIFY_S3_BACKEND;
  const target = backendName
    ? await readS3TargetFromDatabase(process.env, backendName)
    : readS3TargetFromEnv(process.env);
  try {
    const report = {
      label: process.env.MMT_VERIFY_S3_LABEL ?? 'unlabeled',
      ...(await runS3Verification(target)),
    };
    const outputDirectory = path.resolve('artifacts/verification', report.date, 's3');
    await mkdir(outputDirectory, { recursive: true });
    const outputFile = path.join(
      outputDirectory,
      process.env.MMT_VERIFY_S3_OUTPUT ?? 's3-integration.json',
    );
    await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`summary ${JSON.stringify(report.summary)} -> ${path.relative('.', outputFile)}`);
    if (report.summary.failed > 0) process.exitCode = 1;
  } finally {
    target.client.destroy();
  }
}

await main();

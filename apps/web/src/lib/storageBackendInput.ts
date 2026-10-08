import type {
  StorageBackend,
  StorageBackendCreate,
  StorageBackendKind,
  StorageBackendPatch,
} from '@mmt/contracts';
import type { FormValues } from '../types/form';
import { getFieldValue } from './formValues';
import { text, textTemplates } from '../i18n/catalog';

const MIB = 1024 * 1024;
// S3 rejects parts below 5 MiB (except the last) and above 5 GiB; the API checks the same range.
export const MIN_MULTIPART_PART_SIZE_MIB = 5;
export const MAX_MULTIPART_PART_SIZE_MIB = 5 * 1024;
// Same as the API's DEFAULT_UPLOAD_PART_BYTES, so a new backend uploads as before.
export const DEFAULT_MULTIPART_PART_SIZE_MIB = 16;
// The S3 default region; most S3-compatible servers accept it too.
export const DEFAULT_S3_REGION = 'us-east-1';

// The backend name is stored on every artifact, so the API keeps it short and URL-safe.
const BACKEND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// S3 bucket naming rules (general purpose buckets).
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
// The API accepts a CA bundle only as PEM certificates.
export const PEM_CERTIFICATE_HEADER = '-----BEGIN CERTIFICATE-----';

/** Form values for a new backend. */
export function createStorageBackendValues(): FormValues {
  return {
    name: '',
    kind: 's3',
    rootPath: '',
    endpoint: '',
    region: DEFAULT_S3_REGION,
    bucket: '',
    prefix: '',
    pathStyle: 'false',
    signatureVersion: 'v4',
    tlsVerify: 'true',
    caBundle: '',
    clearCaBundle: 'false',
    checksumMode: 'when_required',
    multipartEnabled: 'true',
    multipartPartSizeMib: String(DEFAULT_MULTIPART_PART_SIZE_MIB),
    accessKeyId: '',
    secretAccessKey: '',
    enabled: 'true',
  };
}

/** Form values for editing a saved backend. Write-only values (secret, CA) start empty. */
export function updateStorageBackendValues(backend: StorageBackend): FormValues {
  return {
    ...createStorageBackendValues(),
    name: backend.name,
    kind: backend.kind,
    rootPath: backend.rootPath ?? '',
    endpoint: backend.endpoint ?? '',
    region: backend.region ?? DEFAULT_S3_REGION,
    bucket: backend.bucket ?? '',
    prefix: backend.prefix ?? '',
    pathStyle: String(backend.pathStyle ?? false),
    signatureVersion: backend.signatureVersion,
    tlsVerify: String(backend.tlsVerify),
    checksumMode: backend.checksumMode,
    multipartEnabled: String(backend.multipartEnabled ?? true),
    multipartPartSizeMib: String(Math.round(backend.multipartPartSizeBytes / MIB)),
    accessKeyId: backend.accessKeyId ?? '',
    enabled: String(backend.enabled),
  };
}

type BackendSettings = Omit<StorageBackendCreate, 'name' | 'kind' | 'caBundle' | 'secretAccessKey'>;

/** Builds POST /admin/storage-backends. Throws with the text to show when a value is invalid. */
export function buildStorageBackendCreate(values: FormValues): StorageBackendCreate {
  const name = getFieldValue(values, 'name').trim();
  if (!BACKEND_NAME_PATTERN.test(name)) throw new Error(text.storageNameError);
  const kind = getKind(values);
  if (kind === 'filesystem') return { name, kind, ...buildFilesystemSettings(values) };
  const caBundle = getCaBundle(values);
  const secretAccessKey = getFieldValue(values, 'secretAccessKey');
  const settings = omitUnset(buildS3Settings(values));
  if (settings.accessKeyId && !secretAccessKey) throw new Error(text.storageSecretRequired);
  return {
    name,
    kind,
    ...settings,
    ...(caBundle ? { caBundle } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
  };
}

/**
 * Builds PATCH /admin/storage-backends/:name. A cleared endpoint or access key id is sent as null
 * (and a cleared prefix as '') so the stored value is removed; clearing the access key id removes
 * the secret with it. An empty secret or CA field instead leaves the stored value alone, because
 * the API never returns them for the form to show and send back.
 */
export function buildStorageBackendPatch(
  values: FormValues,
  backend: StorageBackend,
): StorageBackendPatch {
  if (backend.kind === 'filesystem') return buildFilesystemSettings(values);
  const settings = buildS3Settings(values);
  const caBundle = getCaBundle(values);
  const secretAccessKey = getFieldValue(values, 'secretAccessKey');
  if (settings.accessKeyId && !secretAccessKey && !backend.secretConfigured)
    throw new Error(text.storageSecretRequired);
  const patch: StorageBackendPatch = { ...settings };
  if (caBundle) patch.caBundle = caBundle;
  else if (getFieldValue(values, 'clearCaBundle') === 'true') patch.caBundle = null;
  if (secretAccessKey && settings.accessKeyId) patch.secretAccessKey = secretAccessKey;
  return patch;
}

function getSignatureVersion(values: FormValues): StorageBackend['signatureVersion'] {
  return getFieldValue(values, 'signatureVersion') === 'v2' ? 'v2' : 'v4';
}

export function isSignatureV2(values: FormValues): boolean {
  return getSignatureVersion(values) === 'v2';
}

function getKind(values: FormValues): StorageBackendKind {
  return getFieldValue(values, 'kind') === 'filesystem' ? 'filesystem' : 's3';
}

function buildFilesystemSettings(values: FormValues): BackendSettings {
  const rootPath = getFieldValue(values, 'rootPath').trim();
  if (!rootPath.startsWith('/')) throw new Error(text.storageRootPathError);
  return { rootPath, enabled: isChecked(values, 'enabled') };
}

function buildS3Settings(values: FormValues): BackendSettings {
  const endpoint = getFieldValue(values, 'endpoint').trim();
  if (endpoint && !isHttpUrl(endpoint)) throw new Error(text.storageEndpointError);
  const bucket = getFieldValue(values, 'bucket').trim();
  if (!isValidBucketName(bucket)) throw new Error(text.storageBucketError);
  const region = getFieldValue(values, 'region').trim();
  if (!region) throw new Error(text.required);
  const accessKeyId = getFieldValue(values, 'accessKeyId').trim();
  const prefix = normalizePrefix(getFieldValue(values, 'prefix'));
  return {
    endpoint: endpoint || null,
    region,
    bucket,
    prefix,
    pathStyle: isChecked(values, 'pathStyle'),
    signatureVersion: getSignatureVersion(values),
    tlsVerify: isChecked(values, 'tlsVerify'),
    // The API stores v2 backends only with WHEN_REQUIRED, so v2 hides the choice and sends it.
    checksumMode: isSignatureV2(values)
      ? 'when_required'
      : (getFieldValue(values, 'checksumMode') as StorageBackend['checksumMode']),
    multipartEnabled: isChecked(values, 'multipartEnabled'),
    multipartPartSizeBytes: parsePartSizeMib(getFieldValue(values, 'multipartPartSizeMib')) * MIB,
    accessKeyId: accessKeyId || null,
    enabled: isChecked(values, 'enabled'),
  };
}

/** A new backend has nothing to clear, so optional values left empty are not sent. */
function omitUnset(settings: BackendSettings): BackendSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== '' && value !== null),
  ) as BackendSettings;
}

function getCaBundle(values: FormValues): string {
  const caBundle = getFieldValue(values, 'caBundle').trim();
  if (caBundle && !caBundle.includes(PEM_CERTIFICATE_HEADER))
    throw new Error(text.storageCaBundleError);
  return caBundle;
}

function isChecked(values: FormValues, name: string): boolean {
  return getFieldValue(values, name) === 'true';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidBucketName(bucket: string): boolean {
  return BUCKET_NAME_PATTERN.test(bucket) && !bucket.includes('..') && !IPV4_PATTERN.test(bucket);
}

/** Keys are joined as `<prefix>/<key>`, so surrounding slashes would make empty path segments. */
function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, '');
}

function parsePartSizeMib(value: string): number {
  const mib = Number(value);
  if (
    !Number.isSafeInteger(mib) ||
    mib < MIN_MULTIPART_PART_SIZE_MIB ||
    mib > MAX_MULTIPART_PART_SIZE_MIB
  )
    throw new Error(
      textTemplates.storagePartSizeError(MIN_MULTIPART_PART_SIZE_MIB, MAX_MULTIPART_PART_SIZE_MIB),
    );
  return mib;
}

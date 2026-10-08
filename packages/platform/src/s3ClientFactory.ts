import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { signS3RequestV2 } from './s3SignatureV2.js';
import type { S3BackendConfig, S3ChecksumMode } from './storageBackendConfig.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}
export interface S3ClientSettings {
  config: Pick<
    S3BackendConfig,
    | 'endpoint'
    | 'region'
    | 'bucket'
    | 'pathStyle'
    | 'signatureVersion'
    | 'tlsVerify'
    | 'checksumMode'
  >;
  /** Absent means the SDK's default chain (instance role, environment, profile). */
  credentials?: S3Credentials;
  /** PEM bundle of a private CA. When set, Node trusts only these roots for this client. */
  caBundle?: string;
}

// An unreachable endpoint should fail a connection test promptly instead of hanging the request.
const S3_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Headers that belong to v4 payload signing or flexible checksums. Services that only speak v2
 * predate them and may reject the request, so they are removed before the v2 signer runs.
 * WHEN_REQUIRED adds a checksum only to operations S3 refuses without one (DeleteObjects), and
 * those carry an in-memory XML body, so Content-MD5 takes the removed checksum's place.
 */
const V4_ONLY_HEADER_PATTERN =
  /^x-amz-(checksum-.+|sdk-checksum-algorithm|content-sha256|decoded-content-length|trailer)$/i;
const V2_HEADER_FILTER_MIDDLEWARE = 's3SignatureV2HeaderFilter';

type SignerConstructor = NonNullable<S3ClientConfig['signerConstructor']>;
type SignerOptions = ConstructorParameters<SignerConstructor>[0];
type RequestSigner = InstanceType<SignerConstructor>;

/**
 * Many S3-compatible services reject the CRC checksums newer SDKs add to every request, so the
 * default sends checksums only where the API requires them (decisions.md).
 */
function checksumSettings(
  mode: S3ChecksumMode,
): Pick<S3ClientConfig, 'requestChecksumCalculation' | 'responseChecksumValidation'> {
  const setting = mode === 'when_supported' ? 'WHEN_SUPPORTED' : 'WHEN_REQUIRED';
  return { requestChecksumCalculation: setting, responseChecksumValidation: setting };
}

/**
 * The SDK constructs the signer with its resolved credential provider, so v2 uses the same
 * credentials as v4 would: the static key when configured, otherwise the default chain.
 */
function signatureV2SignerConstructor({
  bucket,
  pathStyle,
}: Pick<S3BackendConfig, 'bucket' | 'pathStyle'>): SignerConstructor {
  return class S3SignatureV2Signer implements RequestSigner {
    private readonly credentials: SignerOptions['credentials'];
    constructor(options: SignerOptions) {
      this.credentials = options.credentials;
    }
    sign: RequestSigner['sign'] = (request, options) => {
      return signS3RequestV2({
        request,
        credentials: this.credentials,
        bucket,
        pathStyle,
        ...(options?.signingDate ? { signingDate: new Date(options.signingDate) } : {}),
      });
    };
  };
}

function signatureSettings(
  config: S3ClientSettings['config'],
): Pick<S3ClientConfig, 'signerConstructor'> {
  if (config.signatureVersion !== 'v2') return {};
  return { signerConstructor: signatureV2SignerConstructor(config) };
}

export function s3ClientConfig({
  config,
  credentials,
  caBundle,
}: S3ClientSettings): S3ClientConfig {
  return {
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.pathStyle,
    ...checksumSettings(config.checksumMode),
    ...signatureSettings(config),
    ...(credentials ? { credentials } : {}),
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      httpsAgent: {
        rejectUnauthorized: config.tlsVerify,
        ...(caBundle ? { ca: caBundle } : {}),
      },
    },
  };
}

export function replaceV4OnlyHeaders(request: {
  headers: Record<string, string>;
  body?: unknown;
}): void {
  const removed = Object.keys(request.headers).filter((name) => V4_ONLY_HEADER_PATTERN.test(name));
  for (const name of removed) delete request.headers[name];
  const hadChecksum = removed.some((name) => /^x-amz-checksum-/i.test(name));
  const hasContentMd5 = Object.keys(request.headers).some(
    (name) => name.toLowerCase() === 'content-md5',
  );
  const body = request.body;
  if (!hadChecksum || hasContentMd5) return;
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) return;
  request.headers['content-md5'] = createHash('md5').update(body).digest('base64');
}

/** Runs right before signing, after the checksum middleware has added its headers. */
function removeV4OnlyHeaders(client: S3Client): void {
  client.middlewareStack.addRelativeTo(
    <Args extends { request: unknown }, Result>(next: (args: Args) => Promise<Result>) =>
      async (args: Args): Promise<Result> => {
        const request = args.request as { headers?: Record<string, string>; body?: unknown };
        if (request.headers) replaceV4OnlyHeaders({ headers: request.headers, body: request.body });
        return next(args);
      },
    {
      name: V2_HEADER_FILTER_MIDDLEWARE,
      relation: 'before',
      toMiddleware: 'httpSigningMiddleware',
    },
  );
}

export function createS3Client(settings: S3ClientSettings): S3Client {
  const client = new S3Client(s3ClientConfig(settings));
  if (settings.config.signatureVersion === 'v2') removeV4OnlyHeaders(client);
  return client;
}

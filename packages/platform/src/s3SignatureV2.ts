import { createHmac } from 'node:crypto';

/**
 * AWS Signature Version 2 for S3 (HMAC-SHA1), implemented here because the AWS SDK v3 signs only
 * with v4. Some S3-compatible services still accept only v2 (decisions.md).
 * Specification: https://docs.aws.amazon.com/AmazonS3/latest/userguide/RESTAuthentication.html
 */

/** The parts of a request v2 signs; structurally the same as @smithy's HttpRequest. */
export interface S3SignableRequest {
  method: string;
  hostname: string;
  /** The URI-encoded path exactly as sent; v2 signs it literally. */
  path: string;
  /** Decoded query values; null or "" means a name without "=". */
  query?: Record<string, string | string[] | null>;
  headers: Record<string, string>;
}

export interface S3SignatureV2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Query parameters that are part of CanonicalizedResource. The AWS list (acl ... website, delete,
 * response-*) extended with the newer subresources botocore's HmacV1Auth signs, so tagging or
 * restore requests verify on services that implement them.
 */
const SIGNED_SUBRESOURCES = new Set([
  'accelerate',
  'acl',
  'analytics',
  'cors',
  'delete',
  'inventory',
  'lifecycle',
  'location',
  'logging',
  'metrics',
  'notification',
  'object-lock',
  'partNumber',
  'policy',
  'replication',
  'requestPayment',
  'response-cache-control',
  'response-content-disposition',
  'response-content-encoding',
  'response-content-language',
  'response-content-type',
  'response-expires',
  'restore',
  'select',
  'select-type',
  'tagging',
  'torrent',
  'uploadId',
  'uploads',
  'versionId',
  'versioning',
  'versions',
  'website',
]);

const AMZ_HEADER_PREFIX = 'x-amz-';
export const S3_V2_AUTHORIZATION_PREFIX = 'AWS ';

function headerValue(headers: Record<string, string>, name: string): string {
  const values = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value.trim());
  return values.join(',');
}

/** "Unfolds" folded header lines into single spaces, as the specification requires. */
function unfold(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

export function canonicalizedAmzHeaders(headers: Record<string, string>): string {
  const combined = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (!lowerName.startsWith(AMZ_HEADER_PREFIX)) continue;
    combined.set(lowerName, [...(combined.get(lowerName) ?? []), unfold(value)]);
  }
  return [...combined.keys()]
    .sort()
    .map((name) => `${name}:${combined.get(name)!.join(',')}\n`)
    .join('');
}

/** Subresource values are signed decoded, sorted by name. */
function canonicalizedSubresources(query: S3SignableRequest['query'] = {}): string {
  const pairs = Object.keys(query)
    .filter((name) => SIGNED_SUBRESOURCES.has(name))
    .sort()
    .flatMap((name) => {
      const value = query[name];
      const values = Array.isArray(value) ? value : [value];
      return values.map((item) => (item === null || item === '' ? name : `${name}=${item}`));
    });
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/**
 * `hostBucket` is the bucket named by the Host header (virtual-hosted style or a CNAME); for
 * path-style requests the bucket is already the first path segment.
 */
export function canonicalizedResource(
  request: Pick<S3SignableRequest, 'path' | 'query'>,
  hostBucket?: string,
): string {
  const bucketPart = hostBucket ? `/${hostBucket}` : '';
  return `${bucketPart}${request.path || '/'}${canonicalizedSubresources(request.query)}`;
}

/** When x-amz-date is present S3 ignores Date, so its position is signed as "". */
export function stringToSign(request: S3SignableRequest, hostBucket?: string): string {
  const { headers } = request;
  const date = headerValue(headers, 'x-amz-date') ? '' : headerValue(headers, 'date');
  return [
    request.method.toUpperCase(),
    headerValue(headers, 'content-md5'),
    headerValue(headers, 'content-type'),
    date,
    `${canonicalizedAmzHeaders(headers)}${canonicalizedResource(request, hostBucket)}`,
  ].join('\n');
}

export function signatureV2Authorization({
  request,
  credentials,
  hostBucket,
}: {
  request: S3SignableRequest;
  credentials: S3SignatureV2Credentials;
  hostBucket?: string;
}): string {
  const signature = createHmac('sha1', credentials.secretAccessKey)
    .update(stringToSign(request, hostBucket), 'utf8')
    .digest('base64');
  return `${S3_V2_AUTHORIZATION_PREFIX}${credentials.accessKeyId}:${signature}`;
}

/**
 * Finds the bucket a virtual-hosted request names in its Host. Requests the SDK sends path-style
 * (forcePathStyle, or bucket names that are not DNS-compatible) leave the host as the endpoint.
 */
export function hostBucketOf({
  hostname,
  bucket,
  pathStyle,
}: {
  hostname: string;
  bucket: string;
  pathStyle: boolean;
}): string | undefined {
  if (pathStyle) return undefined;
  return hostname === bucket || hostname.startsWith(`${bucket}.`) ? bucket : undefined;
}

/** HTTP-date (RFC 7231 IMF-fixdate), which every S3 implementation parses. */
function httpDate(date: Date): string {
  return date.toUTCString();
}

type CredentialSource = S3SignatureV2Credentials | (() => Promise<S3SignatureV2Credentials>);

/**
 * Adds Date, x-amz-security-token (temporary credentials) and Authorization to a copy of the
 * request. Earlier attempts' Authorization and Date are replaced, so SDK retries re-sign cleanly.
 */
export async function signS3RequestV2<Request extends S3SignableRequest>({
  request,
  credentials,
  bucket,
  pathStyle,
  signingDate = new Date(),
}: {
  request: Request;
  credentials: CredentialSource;
  bucket: string;
  pathStyle: boolean;
  signingDate?: Date;
}): Promise<Request> {
  const identity = typeof credentials === 'function' ? await credentials() : credentials;
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(
      ([name]) => !['authorization', 'date', 'x-amz-security-token'].includes(name.toLowerCase()),
    ),
  );
  headers.date = httpDate(signingDate);
  if (identity.sessionToken) headers['x-amz-security-token'] = identity.sessionToken;
  const signed: Request = Object.assign(
    Object.create(Object.getPrototypeOf(request) as object) as Request,
    request,
    { headers },
  );
  headers.authorization = signatureV2Authorization({
    request: signed,
    credentials: identity,
    hostBucket: hostBucketOf({ hostname: request.hostname, bucket, pathStyle }),
  });
  return signed;
}

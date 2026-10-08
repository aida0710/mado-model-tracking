import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { S3BackendConfig, S3ChecksumMode } from './storageBackendConfig.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}
export interface S3ClientSettings {
  config: Pick<S3BackendConfig, 'endpoint' | 'region' | 'pathStyle' | 'tlsVerify' | 'checksumMode'>;
  /** Absent means the SDK's default chain (instance role, environment, profile). */
  credentials?: S3Credentials;
  /** PEM bundle of a private CA. When set, Node trusts only these roots for this client. */
  caBundle?: string;
}

// An unreachable endpoint should fail a connection test promptly instead of hanging the request.
const S3_CONNECTION_TIMEOUT_MS = 10_000;

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

export function createS3Client(settings: S3ClientSettings): S3Client {
  return new S3Client(s3ClientConfig(settings));
}

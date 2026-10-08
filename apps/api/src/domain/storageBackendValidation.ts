import { z } from 'zod';

// A full public CA bundle is about 200 KiB; a private CA chain is far smaller.
const MAX_CA_BUNDLE_LENGTH = 1024 * 1024;
// AWS access key ids are 20 characters; S3-compatible services use up to about 128.
const MAX_ACCESS_KEY_ID_LENGTH = 256;
const MAX_SECRET_ACCESS_KEY_LENGTH = 1024;
const MAX_SETTING_LENGTH = 2000;

const caBundleSchema = z
  .string()
  .max(MAX_CA_BUNDLE_LENGTH)
  .refine((pem) => pem.includes('-----BEGIN CERTIFICATE-----'));
// Detailed format rules live in @mmt/platform normalizeStorageBackendConfig; this bounds sizes.
const backendSettingsShape = {
  kind: z.enum(['filesystem', 's3']),
  rootPath: z.string().min(1).max(MAX_SETTING_LENGTH),
  endpoint: z.string().max(MAX_SETTING_LENGTH).nullable(),
  region: z.string().max(64),
  bucket: z.string().max(63),
  prefix: z.string().max(MAX_SETTING_LENGTH),
  pathStyle: z.boolean(),
  signatureVersion: z.enum(['v4', 'v2']),
  tlsVerify: z.boolean(),
  checksumMode: z.enum(['when_required', 'when_supported']),
  multipartPartSizeBytes: z.number().int().positive(),
  multipartEnabled: z.boolean(),
  caBundle: caBundleSchema.nullable(),
  accessKeyId: z.string().min(1).max(MAX_ACCESS_KEY_ID_LENGTH).nullable(),
  secretAccessKey: z.string().min(1).max(MAX_SECRET_ACCESS_KEY_LENGTH).nullable(),
  enabled: z.boolean(),
};

export const storageBackendCreateSchema = z
  .strictObject(backendSettingsShape)
  .partial()
  .extend({ name: z.string().min(1).max(63), kind: backendSettingsShape.kind });
export const storageBackendPatchSchema = z.strictObject(backendSettingsShape).partial();
export const storageSettingsSchema = z.strictObject({ defaultBackend: z.string().min(1).max(63) });

export type StorageBackendCreateInput = z.infer<typeof storageBackendCreateSchema>;
export type StorageBackendPatchInput = z.infer<typeof storageBackendPatchSchema>;

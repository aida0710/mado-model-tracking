import { z } from 'zod';
import type {
  ArtifactUpload,
  ArtifactUploadDetail,
  ArtifactUploadPart,
} from '../artifactUploads.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

const artifactUploadFields = {
  id: idSchema,
  projectId: idSchema,
  runId: idSchema.nullable(),
  path: z.string(),
  backend: z.string(),
  mimeType: z.string(),
  expectedSize: z.number().int(),
  expectedSha256: z.string().nullable(),
  partSize: z.number().int(),
  partCount: z.number().int(),
  status: z.enum(['open', 'verifying', 'completed', 'aborted', 'expired', 'failed']),
  artifactId: idSchema.nullable(),
  error: z.string().nullable(),
  expiresAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};
export const artifactUploadSchema = namedContractSchema(
  'ArtifactUpload',
  z.strictObject(artifactUploadFields),
);
export const artifactUploadPartSchema = namedContractSchema(
  'ArtifactUploadPart',
  z.strictObject({
    partNumber: z.number().int(),
    size: z.number().int(),
    sha256: z.string(),
    receivedAt: timestampSchema,
  }),
);
export const artifactUploadDetailSchema = namedContractSchema(
  'ArtifactUploadDetail',
  z.strictObject({ ...artifactUploadFields, receivedParts: z.array(artifactUploadPartSchema) }),
);

type _ArtifactUpload = Expect<
  MutuallyAssignable<z.infer<typeof artifactUploadSchema>, ArtifactUpload>
>;
type _ArtifactUploadPart = Expect<
  MutuallyAssignable<z.infer<typeof artifactUploadPartSchema>, ArtifactUploadPart>
>;
type _ArtifactUploadDetail = Expect<
  MutuallyAssignable<z.infer<typeof artifactUploadDetailSchema>, ArtifactUploadDetail>
>;

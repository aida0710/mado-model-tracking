import { z } from 'zod';
import type { AdminProject } from '../projectAdministration.js';
import { idSchema, projectVisibilitySchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const adminProjectSchema = namedContractSchema(
  'AdminProject',
  z.strictObject({
    id: idSchema,
    name: z.string(),
    description: z.string(),
    artifactBackend: z.string(),
    visibility: projectVisibilitySchema,
    memberCount: z.number().int(),
    runCount: z.number().int(),
    createdAt: timestampSchema,
    archivedAt: timestampSchema.nullable(),
  }),
);

type _AdminProject = Expect<MutuallyAssignable<z.infer<typeof adminProjectSchema>, AdminProject>>;

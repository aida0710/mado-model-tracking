import { z } from 'zod';
import type { ComputeTargetOverview } from '../index.js';
import {
  computeTargetExecutorSchema,
  computeTargetVisibilitySchema,
  cpuArchSchema,
  siteSubmissionModeSchema,
} from './execution.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const computeTargetOverviewSchema = namedContractSchema(
  'ComputeTargetOverview',
  z.strictObject({
    id: idSchema,
    name: z.string(),
    executor: computeTargetExecutorSchema,
    submissionMode: siteSubmissionModeSchema,
    cpuArch: cpuArchSchema,
    supportsArray: z.boolean(),
    enabled: z.boolean(),
    visibility: computeTargetVisibilitySchema,
    ownerUserId: idSchema.nullable(),
    ownerName: z.string().nullable(),
    usable: z.boolean(),
    canManage: z.boolean(),
    launcher: z
      .strictObject({
        name: z.string(),
        lastSeenAt: timestampSchema.nullable(),
        revoked: z.boolean(),
      })
      .nullable(),
  }),
);

type _ComputeTargetOverview = Expect<
  MutuallyAssignable<z.infer<typeof computeTargetOverviewSchema>, ComputeTargetOverview>
>;

import { z } from 'zod';
import type { ProjectVisibility } from '@mmt/contracts';
import { artifactBackendSchema, nameSchema, roleSchema, uuidSchema } from './validation.js';

// The create dialog adds members one person at a time; a larger audience is a group binding.
export const PROJECT_CREATE_MAX_MEMBERS = 100;

const PROJECT_VISIBILITIES = ['public', 'private'] as const satisfies readonly ProjectVisibility[];
const projectVisibilitySchema = z.enum(PROJECT_VISIBILITIES);
const projectDescriptionSchema = z.string().max(20000);

export const projectCreateSchema = z.strictObject({
  name: nameSchema,
  description: projectDescriptionSchema.default(''),
  artifactBackend: artifactBackendSchema.default('filesystem'),
  visibility: projectVisibilitySchema.default('public'),
  members: z
    .array(z.strictObject({ userId: uuidSchema, role: roleSchema }))
    .max(PROJECT_CREATE_MAX_MEMBERS)
    .default([]),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

// No defaults here: an omitted field keeps its value (zod applies defaults even to partial fields).
export const projectPatchSchema = z.strictObject({
  description: projectDescriptionSchema.optional(),
  artifactBackend: artifactBackendSchema.optional(),
  visibility: projectVisibilitySchema.optional(),
});
export type ProjectPatchInput = z.infer<typeof projectPatchSchema>;

// Query values are strings; only the literal "true" includes archived Projects.
export const adminProjectQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

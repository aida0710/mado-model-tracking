import { z } from 'zod';
import { nameSchema, roleSchema, scopeSchema } from './validation.js';

const descriptionSchema = z.string().max(2000);
const uniqueScopesSchema = z
  .array(scopeSchema)
  .min(1)
  .max(7)
  .refine((values) => new Set(values).size === values.length, 'Scopes must be unique');

export const serviceAccountCreateSchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema.default(''),
  role: roleSchema,
});

export const serviceAccountUpdateSchema = z
  .strictObject({
    description: descriptionSchema.optional(),
    role: roleSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: 'At least one field is required',
  });

export const serviceAccountTokenCreateSchema = z.strictObject({
  name: nameSchema,
  scopes: uniqueScopesSchema,
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
});

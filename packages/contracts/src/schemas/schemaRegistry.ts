import { z } from 'zod';

/**
 * Response schemas that OpenAPI publishes as named components. The id is the contract type name
 * (`Run`, `ModelVersion`), so `#/components/schemas/<id>` points at the TypeScript type of the
 * same name in packages/contracts.
 */
export const contractSchemaRegistry = z.registry<{ id?: string; description?: string }>();

export function namedContractSchema<T extends z.ZodType>(id: string, schema: T): T {
  contractSchemaRegistry.add(schema, { id });
  return schema;
}

/** A field whose meaning the type alone does not tell; the description appears in OpenAPI. */
export function describedField<T extends z.ZodType>(schema: T, description: string): T {
  contractSchemaRegistry.add(schema, { description });
  return schema;
}

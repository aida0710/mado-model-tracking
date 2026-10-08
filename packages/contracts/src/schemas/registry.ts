import { z } from 'zod';
import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  ExternalDatasetRef,
  Model,
  ModelVersion,
} from '../index.js';
import {
  idSchema,
  jsonObjectSchema,
  runKindSchema,
  stringMapSchema,
  timestampSchema,
} from './primitives.js';
import { codeSourceSchema, executionRuntimeSchema } from './runs.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const modelSchema = namedContractSchema(
  'Model',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    family: z.string(),
    description: z.string(),
    latestVersion: z.string().nullable(),
    aliases: stringMapSchema,
    createdAt: timestampSchema,
  }),
);
export const modelVersionSchema = namedContractSchema(
  'ModelVersion',
  z.strictObject({
    id: idSchema,
    modelId: idSchema,
    projectId: idSchema,
    version: z.string(),
    family: z.string(),
    sourceRunId: idSchema.nullable(),
    parentModelVersionIds: z.array(idSchema),
    weightsUri: z.string().nullable(),
    artifactId: idSchema.nullable(),
    defaultCodeVersionId: idSchema.nullable(),
    metadata: jsonObjectSchema,
    createdAt: timestampSchema,
  }),
);
export const codeSchema = namedContractSchema(
  'Code',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    description: z.string(),
    latestVersion: z.string().nullable(),
    createdAt: timestampSchema,
  }),
);
export const codeVersionSchema = namedContractSchema(
  'CodeVersion',
  z.strictObject({
    id: idSchema,
    codeId: idSchema,
    projectId: idSchema,
    version: z.string(),
    source: codeSourceSchema.nullable(),
    runtime: executionRuntimeSchema,
    entrypoint: z.array(z.string()),
    testEntrypoint: z.array(z.string()).optional(),
    requirements: z.array(z.string()),
    environment: stringMapSchema,
    supportedModelFamilies: z.array(z.string()),
    taskTypes: z.array(runKindSchema),
    createdAt: timestampSchema,
  }),
);
export const externalDatasetRefSchema = namedContractSchema(
  'ExternalDatasetRef',
  z.strictObject({
    pluginId: idSchema,
    externalId: z.string(),
    namespace: z.string(),
    name: z.string(),
    version: z.string(),
  }),
);
export const datasetSchema = namedContractSchema(
  'Dataset',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    namespace: z.string(),
    description: z.string(),
    latestVersion: z.string().nullable(),
    createdAt: timestampSchema,
  }),
);
export const datasetVersionSchema = namedContractSchema(
  'DatasetVersion',
  z.strictObject({
    id: idSchema,
    datasetId: idSchema,
    projectId: idSchema,
    name: z.string(),
    namespace: z.string(),
    version: z.string(),
    uri: z.string(),
    digest: z.string(),
    schema: jsonObjectSchema,
    metadata: jsonObjectSchema,
    sourceRunId: idSchema.nullable(),
    parentDatasetVersionIds: z.array(idSchema),
    externalRef: externalDatasetRefSchema.nullable(),
    contentKind: z.enum(['reference', 'artifacts']),
    fileCount: z.number().int().nullable(),
    totalSize: z.number().int().nullable(),
    createdAt: timestampSchema,
  }),
);

type _Model = Expect<MutuallyAssignable<z.infer<typeof modelSchema>, Model>>;
type _ModelVersion = Expect<MutuallyAssignable<z.infer<typeof modelVersionSchema>, ModelVersion>>;
type _Code = Expect<MutuallyAssignable<z.infer<typeof codeSchema>, Code>>;
type _CodeVersion = Expect<MutuallyAssignable<z.infer<typeof codeVersionSchema>, CodeVersion>>;
type _ExternalDatasetRef = Expect<
  MutuallyAssignable<z.infer<typeof externalDatasetRefSchema>, ExternalDatasetRef>
>;
type _Dataset = Expect<MutuallyAssignable<z.infer<typeof datasetSchema>, Dataset>>;
type _DatasetVersion = Expect<
  MutuallyAssignable<z.infer<typeof datasetVersionSchema>, DatasetVersion>
>;

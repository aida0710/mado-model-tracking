import { z } from 'zod';
import type { LineageGraph, PluginConnection, PluginDataset, PluginManifest } from '../index.js';
import { idSchema, jsonObjectSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const pluginManifestSchema = namedContractSchema(
  'PluginManifest',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    protocolVersion: z.literal('1.0'),
    capabilities: z.array(z.string()),
  }),
);
export const pluginConnectionSchema = namedContractSchema(
  'PluginConnection',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    baseUrl: z.string(),
    tokenEnv: z.string(),
    enabled: z.boolean(),
    manifest: pluginManifestSchema.nullable(),
    createdAt: timestampSchema,
  }),
);
export const pluginDatasetSchema = namedContractSchema(
  'PluginDataset',
  z.strictObject({
    externalId: z.string(),
    namespace: z.string(),
    name: z.string(),
    version: z.string(),
    uri: z.string(),
    digest: z.string(),
    schema: jsonObjectSchema,
    metadata: jsonObjectSchema,
  }),
);
export const lineageGraphSchema = namedContractSchema(
  'LineageGraph',
  z.strictObject({
    nodes: z.array(
      z.strictObject({
        id: z.string(),
        kind: z.enum(['datasetVersion', 'modelVersion', 'loggedModel', 'run', 'codeVersion']),
        label: z.string(),
        status: z.string().optional(),
        sourceRunId: z.string().optional(),
      }),
    ),
    edges: z.array(
      z.strictObject({ source: z.string(), target: z.string(), relation: z.string() }),
    ),
  }),
);

type _PluginManifest = Expect<
  MutuallyAssignable<z.infer<typeof pluginManifestSchema>, PluginManifest>
>;
type _PluginConnection = Expect<
  MutuallyAssignable<z.infer<typeof pluginConnectionSchema>, PluginConnection>
>;
type _PluginDataset = Expect<
  MutuallyAssignable<z.infer<typeof pluginDatasetSchema>, PluginDataset>
>;
type _LineageGraph = Expect<MutuallyAssignable<z.infer<typeof lineageGraphSchema>, LineageGraph>>;

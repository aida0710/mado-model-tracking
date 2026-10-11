import { z } from 'zod';
import type {
  DirectorySuggestions,
  StorageBackend,
  StorageBackendChoices,
  StorageSettings,
  StorageTestResult,
  StorageTestStep,
} from '../storageBackends.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const storageBackendSchema = namedContractSchema(
  'StorageBackend',
  z.strictObject({
    name: z.string(),
    kind: z.enum(['filesystem', 's3']),
    source: z.enum(['environment', 'database']),
    rootPath: z.string().optional(),
    endpoint: z.string().optional(),
    region: z.string().optional(),
    bucket: z.string().optional(),
    prefix: z.string().optional(),
    pathStyle: z.boolean().optional(),
    signatureVersion: z.enum(['v4', 'v2']),
    tlsVerify: z.boolean(),
    caBundleConfigured: z.boolean(),
    checksumMode: z.enum(['when_required', 'when_supported']),
    multipartPartSizeBytes: z.number().int(),
    multipartEnabled: z.boolean().optional(),
    accessKeyId: z.string().optional(),
    secretConfigured: z.boolean(),
    enabled: z.boolean(),
  }),
);
export const storageSettingsSchema = namedContractSchema(
  'StorageSettings',
  z.strictObject({ defaultBackend: z.string() }),
);
export const storageTestStepSchema = namedContractSchema(
  'StorageTestStep',
  z.strictObject({
    name: z.enum(['put', 'get', 'range', 'delete']),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
);
export const storageTestResultSchema = namedContractSchema(
  'StorageTestResult',
  z.strictObject({ steps: z.array(storageTestStepSchema) }),
);
export const storageBackendChoicesSchema = namedContractSchema(
  'StorageBackendChoices',
  z.strictObject({ items: z.array(z.string()), defaultBackend: z.string() }),
);
export const directorySuggestionsSchema = namedContractSchema(
  'DirectorySuggestions',
  z.strictObject({
    resolvedPath: z.string(),
    status: z.enum(['directory', 'missing', 'not_directory', 'unavailable']),
    items: z.array(z.string()),
    truncated: z.boolean(),
  }),
);

type _StorageBackend = Expect<
  MutuallyAssignable<z.infer<typeof storageBackendSchema>, StorageBackend>
>;
type _StorageSettings = Expect<
  MutuallyAssignable<z.infer<typeof storageSettingsSchema>, StorageSettings>
>;
type _StorageTestStep = Expect<
  MutuallyAssignable<z.infer<typeof storageTestStepSchema>, StorageTestStep>
>;
type _StorageTestResult = Expect<
  MutuallyAssignable<z.infer<typeof storageTestResultSchema>, StorageTestResult>
>;
type _StorageBackendChoices = Expect<
  MutuallyAssignable<z.infer<typeof storageBackendChoicesSchema>, StorageBackendChoices>
>;
type _DirectorySuggestions = Expect<
  MutuallyAssignable<z.infer<typeof directorySuggestionsSchema>, DirectorySuggestions>
>;

import type { Model, ModelVersion } from '@mmt/contracts';
import type { useRegistry } from '../hooks/useRegistry';

export type ModelRegistryState = ReturnType<typeof useRegistry<Model, ModelVersion>>;

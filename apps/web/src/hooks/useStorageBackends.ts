import type { StorageBackendKind } from '@mmt/contracts';
import { storageApi } from '../api/storage';
import { useAuth } from './useAuth';
import { useQuery } from './useQuery';
import { isGlobalAdmin } from '../lib/permissions';

/** The admin tab's data: every backend and the default for new Projects. */
export function useStorageBackends() {
  const backends = useQuery('admin-storage-backends', storageApi.backends);
  const settings = useQuery('admin-storage-settings', storageApi.settings);
  return {
    backends,
    settings,
    reload: () => {
      backends.reload();
      settings.reload();
    },
  };
}

export interface StorageBackendChoice {
  name: string;
  /** Only global administrators can read kinds, so other users see names alone. */
  kind?: StorageBackendKind;
}

/** Backends a Project may pick, with the default a new Project starts from. */
export function useStorageBackendChoices() {
  const auth = useAuth();
  const choices = useQuery('storage-backend-choices', storageApi.choices);
  const details = useQuery(
    isGlobalAdmin(auth.user) ? 'storage-backend-choice-details' : null,
    storageApi.backends,
  );
  const kinds = new Map(details.value?.map((backend) => [backend.name, backend.kind]));
  return {
    ...choices,
    value: choices.value && {
      defaultBackend: choices.value.defaultBackend,
      items: choices.value.items.map((name): StorageBackendChoice => ({
        name,
        kind: kinds.get(name),
      })),
    },
  };
}

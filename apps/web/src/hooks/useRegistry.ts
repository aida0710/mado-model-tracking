import { useSearchParams } from 'react-router-dom';
import { useQuery } from './useQuery';
import { text } from '../i18n/catalog';

interface RegistryItem {
  id: string;
}
interface RegistryVersion {
  id: string;
}
interface RegistryLoaders<T, V> {
  list: (signal: AbortSignal) => Promise<T[]>;
  versions: (id: string, signal: AbortSignal) => Promise<V[]>;
  parentId: (version: V) => string;
}
export function useRegistry<T extends RegistryItem, V extends RegistryVersion>(
  key: string,
  loaders: RegistryLoaders<T, V>,
) {
  const [params, setParams] = useSearchParams();
  const requestedVersionId = params.get('version') ?? '';
  const requestedId = params.get('id') ?? '';
  const list = useQuery(`${key}:list`, loaders.list);
  const lookup = useQuery(
    requestedVersionId && !requestedId && list.value ? `${key}:lookup:${requestedVersionId}` : null,
    async (signal) => {
      const versions = (
        await Promise.all((list.value ?? []).map((item) => loaders.versions(item.id, signal)))
      ).flat();
      return versions.find((version) => version.id === requestedVersionId) ?? null;
    },
  );
  const selectedId =
    requestedId ||
    (requestedVersionId
      ? lookup.value
        ? loaders.parentId(lookup.value)
        : ''
      : (list.value?.[0]?.id ?? ''));
  const selected = list.value?.find((item) => item.id === selectedId);
  const versions = useQuery(selected ? `${key}:versions:${selected.id}` : null, (signal) =>
    loaders.versions(selectedId, signal),
  );
  const selectedVersion = requestedVersionId
    ? versions.value?.find((version) => version.id === requestedVersionId)
    : versions.value?.[0];
  const selectionError =
    requestedId && list.value && !selected
      ? text.itemNotFound
      : requestedVersionId && (lookup.value === null || (versions.value && !selectedVersion))
        ? text.versionNotFound
        : null;
  const selectItem = (id: string) => setParams({ id });
  const selectVersion = (id: string) => setParams({ id: selectedId, version: id });
  function reload() {
    list.reload();
    versions.reload();
    lookup.reload();
  }
  return {
    list,
    lookup,
    selected,
    versions,
    selectedVersion,
    selectionError,
    selectItem,
    selectVersion,
    reload,
  };
}

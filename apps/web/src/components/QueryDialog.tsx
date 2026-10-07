import type { ReactNode } from 'react';
import type { QueryState } from '../hooks/useQuery';
import { Dialog } from './Dialog';
import { Resource } from './Feedback';

export function QueryDialog<T>({
  title,
  query,
  onClose,
  children,
}: {
  title: string;
  query: QueryState<T>;
  onClose: () => void;
  children: (value: T) => ReactNode;
}) {
  if (query.error || query.value === undefined)
    return (
      <Dialog title={title} onClose={onClose}>
        <Resource query={query}>{() => null}</Resource>
      </Dialog>
    );
  return children(query.value);
}

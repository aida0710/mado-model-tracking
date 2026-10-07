import type { ReactNode } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import type { QueryState } from '../hooks/useQuery';
import { text } from '../i18n/catalog';

export function ErrorNotice({ message, retry }: { message: string | null; retry?: () => void }) {
  if (!message) return null;
  return (
    <div className="notice error" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
      {retry && (
        <button className="button small" onClick={retry}>
          <RefreshCw size={14} />
          {text.retry}
        </button>
      )}
    </div>
  );
}
export function Loading() {
  return (
    <div className="state-message" role="status">
      <LoaderCircle className="spin" size={18} />
      {text.loading}
    </div>
  );
}
export function Empty({ children = text.empty }: { children?: ReactNode }) {
  return <div className="state-message">{children}</div>;
}
export function Resource<T>({
  query,
  children,
}: {
  query: QueryState<T>;
  children: (value: T) => ReactNode;
}) {
  if (query.error) return <ErrorNotice message={query.error} retry={query.reload} />;
  if (query.value === undefined) return query.loading ? <Loading /> : null;
  return <>{children(query.value)}</>;
}

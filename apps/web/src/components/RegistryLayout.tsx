import type { ReactNode } from 'react';

export function RegistryLayout({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="registry-layout">
      <section className="registry-list">{list}</section>
      <section className="registry-detail">{children}</section>
    </div>
  );
}

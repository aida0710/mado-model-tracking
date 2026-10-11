import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { AdminProject } from '@mmt/contracts';
import { AdminProjectsTable } from './AdminProjectsTable';
import { text } from '../../i18n/catalog';

const adminProject = (overrides: Partial<AdminProject>): AdminProject => ({
  id: 'p1',
  name: 'Speech',
  description: '',
  artifactBackend: 'filesystem',
  visibility: 'public',
  memberCount: 3,
  runCount: 12,
  createdAt: '2026-10-01T00:00:00Z',
  archivedAt: null,
  ...overrides,
});

const rowOf = (markup: string, name: string) =>
  markup.split('<tr').find((row) => row.includes(name)) ?? '';

describe('AdminProjectsTable', () => {
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <AdminProjectsTable
        projects={[
          adminProject({}),
          adminProject({
            id: 'p2',
            name: 'Archived',
            visibility: 'private',
            archivedAt: '2026-10-10T00:00:00Z',
          }),
        ]}
        onAction={() => undefined}
      />
    </MemoryRouter>,
  );

  it('有効なProjectは名前から開けて、アーカイブだけを操作に出す', () => {
    const row = rowOf(markup, 'Speech');
    expect(row).toContain('href="/projects/p1/experiments"');
    expect(row).toContain(`>${text.projectStateActive}<`);
    expect(row).toContain(`>${text.projectArchive}<`);
    expect(row).not.toContain(text.projectPurge);
  });

  it('アーカイブ済みのProjectは開けず、元に戻すと完全に削除を出す', () => {
    const row = rowOf(markup, 'Archived');
    expect(row).not.toContain('href=');
    expect(row).toContain(`>${text.projectStateArchived}<`);
    expect(row).toContain(`>${text.projectRestore}<`);
    expect(row).toContain(`>${text.projectPurge}<`);
    expect(row).not.toContain(`>${text.projectArchive}<`);
  });

  it('公開範囲・メンバー数・Run数・保存先を並べる', () => {
    const row = rowOf(markup, 'Speech');
    expect(row).toContain(`>${text.public}<`);
    expect(row).toContain('>3<');
    expect(row).toContain('>12<');
    expect(row).toContain('>filesystem<');
    expect(rowOf(markup, 'Archived')).toContain(`>${text.private}<`);
  });
});

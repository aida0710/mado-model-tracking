import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Project } from '@mmt/contracts';
import { ProjectSwitcher } from './ProjectSwitcher';
import { text } from '../i18n/catalog';

const project = (overrides: Partial<Project>): Project => ({
  id: 'p1',
  name: 'Speech',
  description: '',
  artifactBackend: 'filesystem',
  visibility: 'public',
  role: 'editor',
  createdAt: '2026-10-11T00:00:00Z',
  ...overrides,
});

function render(props: Parameters<typeof ProjectSwitcher>[0]) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ProjectSwitcher {...props} />
    </MemoryRouter>,
  );
}

describe('ProjectSwitcher', () => {
  it('閉じているときはボタンだけで、listboxを開くボタンとして今のProject名を示す', () => {
    const projects = [project({}), project({ id: 'p2', name: 'Vision' })];
    const markup = render({ projects, project: projects[0] });
    const button = markup.match(/<button[^>]*project-switcher-trigger[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-haspopup="listbox"');
    expect(button).toContain('aria-expanded="false"');
    expect(markup).toContain('>Speech</span>');
    expect(markup).not.toContain('role="listbox"');
    // The native select is gone.
    expect(markup).not.toContain('<select');
  });

  it('Privateの今のProjectには鍵を付け、名前を読み上げに残す', () => {
    const projects = [project({ visibility: 'private' })];
    const markup = render({ projects, project: projects[0] });
    expect(markup).toContain('lucide-lock');
    expect(markup).toContain(`<span class="sr-only">${text.private}</span>`);
  });

  it('開いていないProjectのURLでは「プロジェクトを選択」と出す', () => {
    const markup = render({ projects: [project({})] });
    expect(markup).toContain(`>${text.projectSwitcherPlaceholder}</span>`);
  });
});

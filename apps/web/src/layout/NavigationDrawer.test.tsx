import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { NavigationDrawer } from './NavigationDrawer';
import { text } from '../i18n/catalog';

describe('NavigationDrawer', () => {
  it('最初は閉じていて、メニューボタンが aria-expanded=false でドロワーを指す', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <NavigationDrawer
          groups={[
            {
              label: '記録',
              links: [{ screen: 'experiments', to: '/projects/p1/experiments', label: 'Experiments' }],
            },
          ]}
        />
      </MemoryRouter>,
    );
    const button = markup.match(/<button[^>]*navigation-toggle[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain(`aria-label="${text.openNavigation}"`);
    const drawerId = button.match(/aria-controls="([^"]+)"/)?.[1];
    expect(markup).toContain(`<dialog id="${drawerId}"`);
    expect(markup).not.toMatch(/<dialog[^>]* open/);
    expect(markup).toContain('href="/projects/p1/experiments"');
    expect(markup).toContain('>記録</span>');
  });
});

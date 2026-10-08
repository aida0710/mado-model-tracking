import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function readDocumentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * The theme useTheme last applied to <html>, for drawing code (canvas, computed colors) that
 * cannot use CSS variables. It follows the attribute so a toggle elsewhere repaints the chart.
 */
export function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readDocumentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readDocumentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

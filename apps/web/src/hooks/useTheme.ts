import { useEffect, useState } from 'react';

// This key belongs to this standalone app rather than Mado's preferences.
const THEME_STORAGE_KEY = 'mmt.theme';
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* The UI still works if storage is unavailable. */
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((previous) => (previous === 'light' ? 'dark' : 'light')) };
}

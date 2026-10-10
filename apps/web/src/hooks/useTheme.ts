import { useEffect, useState } from 'react';

// This key belongs to this standalone app rather than Mado's preferences.
const THEME_STORAGE_KEY = 'mmt.theme';
type Theme = 'light' | 'dark';

/** The theme the user chose last, or the operating system's when they have not chosen one. */
export function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* Fall back to the operating system's setting. */
  }
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  // Only a choice the user made is stored, so the theme follows the operating system until then.
  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* The UI still works if storage is unavailable. */
    }
  };
  return { theme, toggle };
}

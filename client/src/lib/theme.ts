import { useCallback, useEffect, useState } from 'react';

/**
 * Light and dark are the same instrument, not two designs.
 *
 * The stored choice wins; without one the app follows the operating system, so
 * a control room set to dark opens dark. The initial value is applied by an
 * inline script in index.html before first paint, so there is never a flash.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'committeeflow.theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // Private browsing or blocked site data — fall back to the system setting.
    return null;
  }
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset['theme'] as Theme | undefined) ?? 'light',
  );

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  // Follow the OS while the user has expressed no preference of their own.
  useEffect(() => {
    if (readStored()) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(systemTheme());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The toggle still works for this session even if it cannot be stored.
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}

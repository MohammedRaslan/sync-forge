import { useEffect, useState } from 'react';

/** Colour theme of the UI. Dark is the design reference and the default without JS. */
export type Theme = 'light' | 'dark';

/** Must match the pre-paint script in index.html. */
const STORAGE_KEY = 'syncforge.theme';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

// The --abyss token of each theme, so the browser chrome blends into the page.
const THEME_COLOR: Record<Theme, string> = { dark: '#0d1530', light: '#f3f5fa' };

function documentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

function hasSavedTheme(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark';
  } catch {
    // Storage can be blocked (private windows, site settings): treat it as no choice.
    return false;
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the choice still holds until the page is reloaded.
  }
}

/**
 * The current theme and a toggle. Starts from the theme the pre-paint script set on <html>.
 * Follows the system setting live until the user toggles; the toggle is saved and wins from then on.
 */
export function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(documentTheme);
  const [chosen, setChosen] = useState(hasSavedTheme);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (chosen) return;
    const media = window.matchMedia(LIGHT_QUERY);
    const follow = (event: MediaQueryListEvent) => setTheme(event.matches ? 'light' : 'dark');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [chosen]);

  const toggle = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    saveTheme(next);
    setChosen(true);
    setTheme(next);
  };

  return [theme, toggle] as const;
}

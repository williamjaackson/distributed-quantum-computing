import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * Stamps `data-theme` on the root so the explicit choice beats the OS setting in
 * both directions; clearing the attribute hands control back to the media query.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <button className="secondary theme-toggle" onClick={() => setTheme((t) => NEXT[t])}>
      Theme: {LABEL[theme]}
    </button>
  );
}

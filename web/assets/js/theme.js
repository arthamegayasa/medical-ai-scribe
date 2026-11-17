// Theme: 'system' (default), 'light' or 'dark'. Applied as html[data-theme]; absence means system.
const KEY = 'scribe.ui.theme';
const META_COLORS = { light: '#f4f6f5', dark: '#0e1517' };
const listeners = new Set();
const media = window.matchMedia('(prefers-color-scheme: dark)');

function read() {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

let mode = read();

/** @returns {'system'|'light'|'dark'} */
export function getTheme() {
  return mode;
}

/** @returns {'light'|'dark'} the theme actually showing */
export function resolvedTheme() {
  if (mode !== 'system') return mode;
  return media.matches ? 'dark' : 'light';
}

function syncMeta() {
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((meta) => {
    if (!meta.dataset.media) meta.dataset.media = meta.getAttribute('media') || '';
    if (mode === 'system') {
      if (meta.dataset.media) meta.setAttribute('media', meta.dataset.media);
      meta.setAttribute('content', meta.dataset.media.includes('dark') ? META_COLORS.dark : META_COLORS.light);
    } else {
      meta.removeAttribute('media');
      meta.setAttribute('content', META_COLORS[mode]);
    }
  });
}

/** @param {'system'|'light'|'dark'} next */
export function setTheme(next) {
  mode = next === 'light' || next === 'dark' ? next : 'system';
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  syncMeta();
  listeners.forEach((fn) => fn({ mode, resolved: resolvedTheme() }));
}

/** Flip between light and dark based on what is currently showing. */
export function toggleTheme() {
  setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
}

/** @param {(state: {mode: string, resolved: string}) => void} fn @returns {() => void} unsubscribe */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

media.addEventListener('change', () => {
  if (mode === 'system') listeners.forEach((fn) => fn({ mode, resolved: resolvedTheme() }));
});

syncMeta();

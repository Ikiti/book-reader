// Reader display settings (global, persisted) and their application to the page.
import { getSetting, setSetting } from './db.js';

export const FONTS = {
  serif: { label: 'Serif', css: 'Georgia, "Noto Serif", "Times New Roman", serif' },
  sans: { label: 'Sans', css: 'system-ui, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif' },
  book: { label: 'Book', css: '"Palatino Linotype", Palatino, "Book Antiqua", "Noto Serif", serif' },
  mono: { label: 'Mono', css: 'ui-monospace, "Cascadia Mono", Consolas, "Roboto Mono", monospace' },
  readable: { label: 'Readable', css: 'Verdana, "Segoe UI", Tahoma, "Noto Sans", sans-serif' },
};

export const THEMES = { light: 'Light', sepia: 'Sepia', dark: 'Dark', black: 'Black' };

export const DEFAULTS = {
  font: 'serif',
  size: 19, // px
  lineHeight: 1.6,
  width: 38, // em
  theme: 'light',
  justify: false,
  pageMarkers: true,
  noteProvider: 'auto',
  obsidianVault: '',
  obsidianFolder: 'Book Notes',
  keepTipSeen: false, // the "paste into Keep" explanation was read
  ocrLang: 'auto', // picture-only PDF pages: 'auto' | 'eng' | 'heb' | 'eng+heb' | 'off'
};

let current = { ...DEFAULTS };

export async function loadSettings() {
  current = { ...DEFAULTS, ...(await getSetting('reader', {})) };
  applySettings();
  return current;
}

export const settings = () => current;

export async function updateSettings(patch) {
  current = { ...current, ...patch };
  applySettings();
  await setSetting('reader', current);
}

export function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = current.theme;
  r.style.setProperty('--read-font', FONTS[current.font]?.css || FONTS.serif.css);
  r.style.setProperty('--read-size', `${current.size}px`);
  r.style.setProperty('--read-lh', current.lineHeight);
  r.style.setProperty('--read-width', `${current.width}em`);
  r.dataset.justify = current.justify ? '1' : '0';
  r.dataset.markers = current.pageMarkers ? '1' : '0';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(r).getPropertyValue('--bar').trim() || '#ffffff';
}

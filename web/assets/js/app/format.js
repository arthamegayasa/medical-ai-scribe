// Display formatting that follows the interface language.
import { t } from '../i18n.js';
import { PROVIDERS } from '../../../core/providers.js';
import { NOTE_LANGUAGES } from './prefs.js';

export const TEMPLATE_KEYS = Object.freeze({
  general: 'templates.general',
  neurology: 'templates.neurology',
  emergency: 'templates.emergency',
  internal_medicine: 'templates.internal',
  pediatrics: 'templates.pediatrics',
  psychiatry: 'templates.psychiatry',
  follow_up: 'templates.followUp',
});

export const templateLabel = (id) => t(TEMPLATE_KEYS[id] || 'templates.general');
/** Options for the note-language selects: every engine language, labelled in the UI language. */
export const noteLanguageOptions = () => NOTE_LANGUAGES.map((value) => ({ value, key: `app.lang.${value}` }));
export const languageLabel = (code) => (NOTE_LANGUAGES.includes(code) ? t(`app.lang.${code}`) : String(code || ''));

export function providerLabel(id) {
  if (id === 'example') return t('app.conn.example');
  return PROVIDERS.find((p) => p.id === id)?.label || String(id || '');
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  if (h) return t('app.duration.hms', { h, m, s });
  if (m) return t('app.duration.ms', { m, s });
  return t('app.duration.s', { s });
}

export function formatDateTime(iso, lang) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(bytes, lang) {
  const mb = bytes / 1e6;
  const value = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
  return `${value.toLocaleString(lang === 'id' ? 'id-ID' : 'en-US')} MB`;
}

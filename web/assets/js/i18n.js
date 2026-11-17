// Tiny i18n: flat dotted keys, {name} interpolation, declarative data-i18n attributes.
//   <span data-i18n="app.note.title">SOAP draft</span>          -> textContent
//   <input data-i18n-attr="placeholder:app.find.placeholder,aria-label:app.find.open">
// Markup carries the English text so the page reads correctly before (or without) JS.
import en from './strings/en.js';
import id from './strings/id.js';

const KEY = 'scribe.ui.lang';
const dictionaries = { en, id };
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'id', label: 'Bahasa Indonesia' },
];
const listeners = new Set();

function initialLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && dictionaries[saved]) return saved;
  } catch {
    /* ignore */
  }
  // No navigator outside a browser (unit tests on Node 20 import this module).
  const browser = globalThis.navigator || {};
  const nav = (browser.languages || [browser.language || 'en']).map((l) => String(l).toLowerCase());
  return nav.some((l) => l === 'id' || l.startsWith('id-') || l === 'in') ? 'id' : 'en';
}

let lang = initialLang();

/** @returns {'en'|'id'} */
export function getLang() {
  return lang;
}

/**
 * Translate a key. Falls back to English, then to the key itself.
 * @param {string} key
 * @param {Record<string, string|number>} [vars] replaces {name} placeholders
 */
export function t(key, vars) {
  let text = dictionaries[lang]?.[key] ?? dictionaries.en[key];
  if (text === undefined) {
    if (typeof console !== 'undefined') console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (vars) text = text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
  return text;
}

/**
 * Plural helper: looks up `${key}.one` / `${key}.other` and passes {n}.
 * @param {string} key @param {number} n @param {Record<string, string|number>} [vars]
 */
export function tn(key, n, vars = {}) {
  const form = n === 1 ? 'one' : 'other';
  return t(`${key}.${form}`, { n: n.toLocaleString(lang === 'id' ? 'id-ID' : 'en-US'), ...vars });
}

/** Apply translations to every [data-i18n] / [data-i18n-attr] under root (default: document). */
export function applyI18n(root = document) {
  const scope = root.querySelectorAll ? root : document;
  const nodes = scope.querySelectorAll('[data-i18n]');
  nodes.forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  if (root.matches?.('[data-i18n]')) root.textContent = t(root.dataset.i18n);
  const attrNodes = [...scope.querySelectorAll('[data-i18n-attr]')];
  if (root.matches?.('[data-i18n-attr]')) attrNodes.push(root);
  attrNodes.forEach((el) => {
    el.dataset.i18nAttr.split(',').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}

/** @param {'en'|'id'} next */
export function setLang(next) {
  if (!dictionaries[next]) return;
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  applyI18n(document);
  document.querySelectorAll('[data-set-lang]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.setLang === next));
  });
  listeners.forEach((fn) => fn(next));
}

/** @param {(lang: string) => void} fn @returns {() => void} unsubscribe */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Wire every [data-set-lang] button and apply the initial language. */
export function initI18n() {
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-set-lang]');
    if (btn) setLang(btn.dataset.setLang);
  });
  setLang(lang);
}

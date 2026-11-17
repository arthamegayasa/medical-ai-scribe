// Connection records and the key storage policy.
//
// Policy (owner decision): keys are kept for this tab only (sessionStorage) unless the user ticks
// "Remember on this device" (localStorage). Connection metadata (provider, name, endpoint) is a
// preference and is kept on the device; it never contains a key. Keys are never put in app state,
// history, exports, logs, URLs, data-* attributes or error messages: they are read from here only
// at the moment a provider request is made.
import { PROVIDERS, getProvider } from '../../../core/providers.js';

export const LIST_KEY = 'scribe.connections';
export const KEY_PREFIX = 'scribe.key.';
const REMEMBER = new Set(['session', 'device']);
const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));

let counter = 0;
export function newConnectionId(now = Date.now()) {
  counter += 1;
  return `c${now.toString(36)}${counter.toString(36)}`;
}

/** Validates a stored record; returns a clean copy or null. Unknown fields (and any key) are dropped. */
export function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, provider, name, baseUrl, remember, keyed } = raw;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || !PROVIDER_IDS.has(provider)) return null;
  const preset = getProvider(provider);
  return {
    id,
    provider,
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : preset.label,
    baseUrl: preset.customBaseUrl && typeof baseUrl === 'string' ? baseUrl.trim().slice(0, 500) : '',
    remember: REMEMBER.has(remember) ? remember : 'session',
    // Whether a key was saved (a flag, never the key), so a tab-only key that is gone can be
    // reported as "key needed" even for providers where a key is optional.
    keyed: keyed === true,
  };
}

/**
 * @param {{ local: ReturnType<import('./storage.js').safeStorage>, session: ReturnType<import('./storage.js').safeStorage> }} stores
 */
export function createVault({ local, session }) {
  const keyName = (id) => `${KEY_PREFIX}${id}`;
  const readList = () => {
    const raw = local.getJSON(LIST_KEY, []);
    return Array.isArray(raw) ? raw.map(sanitizeRecord).filter(Boolean) : [];
  };
  const writeList = (list) => local.setJSON(LIST_KEY, list.map(sanitizeRecord).filter(Boolean));
  const keyFor = (record) => {
    const value = (record.remember === 'device' ? local : session).get(keyName(record.id));
    return typeof value === 'string' ? value : '';
  };

  return {
    /** Records with `hasKey`, never the key itself. */
    list() {
      return readList().map((record) => ({ ...record, hasKey: Boolean(keyFor(record)) }));
    },

    /**
     * Saves a record. `apiKey` undefined keeps the existing key (moving it if `remember` changed);
     * an empty string removes it.
     */
    save(record, apiKey) {
      const clean = sanitizeRecord(record);
      if (!clean) throw new Error('Invalid connection record.');
      const list = readList();
      const index = list.findIndex((item) => item.id === clean.id);
      const previous = index === -1 ? null : list[index];
      const existingKey = previous ? keyFor(previous) : '';
      const nextKey = apiKey === undefined ? existingKey : String(apiKey).trim();
      local.remove(keyName(clean.id));
      session.remove(keyName(clean.id));
      if (nextKey) (clean.remember === 'device' ? local : session).set(keyName(clean.id), nextKey);
      clean.keyed = Boolean(nextKey);
      if (index === -1) list.push(clean); else list[index] = clean;
      writeList(list);
      return { ...clean, hasKey: Boolean(nextKey) };
    },

    remove(id) {
      local.remove(keyName(id));
      session.remove(keyName(id));
      writeList(readList().filter((item) => item.id !== id));
    },

    /** The engine connection object for a provider request: `{ provider, apiKey?, baseUrl? }`. */
    connection(id) {
      const record = readList().find((item) => item.id === id);
      if (!record) return null;
      const connection = { provider: record.provider };
      const key = keyFor(record);
      if (key) connection.apiKey = key;
      if (record.baseUrl) connection.baseUrl = record.baseUrl;
      return connection;
    },

    rememberedCount() {
      return readList().filter((record) => record.remember === 'device' && keyFor(record)).length;
    },

    /** Removes every record and key (session and device). */
    clearAll() {
      for (const store of [local, session]) for (const key of store.keys(KEY_PREFIX)) store.remove(key);
      local.remove(LIST_KEY);
    },
  };
}

/** Short description for the connection list. Never includes key material. */
export function describeRecord(record, t) {
  const preset = getProvider(record.provider);
  const missing = !record.hasKey && (preset.keyRequired || record.keyed);
  if (missing) return t('app.conn.detailNoKey', { provider: preset.customBaseUrl && record.baseUrl ? record.baseUrl : preset.label });
  if (preset.customBaseUrl && record.baseUrl) return record.baseUrl;
  if (!preset.keyRequired) return preset.label;
  return t(record.remember === 'device' ? 'app.conn.detailDevice' : 'app.conn.detailTab', { provider: preset.label });
}

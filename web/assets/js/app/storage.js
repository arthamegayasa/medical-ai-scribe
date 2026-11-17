// Storage that never throws. Private browsing, blocked site data or a full quota make
// localStorage/sessionStorage unusable; the app then keeps values in memory for this page only.

/**
 * @param {() => Storage} getter returns the backing Storage (may throw)
 * @returns {{ persistent: boolean, get(key: string): string|null, set(key: string, value: string): boolean,
 *   remove(key: string): void, keys(prefix?: string): string[], getJSON(key: string, fallback?: any): any, setJSON(key: string, value: any): boolean }}
 */
export function safeStorage(getter) {
  let backing = null;
  try {
    const candidate = getter();
    const probe = '__scribe_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    backing = candidate;
  } catch {
    backing = null;
  }
  const memory = new Map();

  const api = {
    persistent: Boolean(backing),
    get(key) {
      if (memory.has(key)) return memory.get(key);
      try { return backing ? backing.getItem(key) : null; } catch { return null; }
    },
    set(key, value) {
      const text = String(value);
      if (backing) {
        try {
          backing.setItem(key, text);
          memory.delete(key);
          return true;
        } catch { /* fall back to memory below */ }
      }
      memory.set(key, text);
      return false;
    },
    remove(key) {
      memory.delete(key);
      try { backing?.removeItem(key); } catch { /* ignore */ }
    },
    keys(prefix = '') {
      const found = new Set([...memory.keys()]);
      try {
        if (backing) for (let i = 0; i < backing.length; i++) found.add(backing.key(i));
      } catch { /* ignore */ }
      return [...found].filter((key) => key !== null && key.startsWith(prefix));
    },
    getJSON(key, fallback = null) {
      const raw = api.get(key);
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },
    setJSON(key, value) {
      return api.set(key, JSON.stringify(value));
    },
  };
  return api;
}

/** In-memory Storage implementation (tests, and a stand-in when a browser storage is missing). */
export function memoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

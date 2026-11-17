// Opt-in session history, stored only on this device (IndexedDB). Off by default.
// Records hold the transcript, draft and settings of one encounter; never keys or tokens.
import { SECTIONS } from '../../../core/soap/schema.js';

export const DB_NAME = 'scribe-history';
const STORE = 'sessions';
const DAY_MS = 24 * 60 * 60 * 1000;

export function isExpired(record, days, now = Date.now()) {
  if (!days) return false;
  const updated = Date.parse(record?.updatedAt);
  return !Number.isFinite(updated) || now - updated > days * DAY_MS;
}

/** Deletes expired records; resolves to the number removed. */
export async function purgeExpired(store, days, now = Date.now()) {
  if (!days) return 0;
  let removed = 0;
  for (const record of await store.list()) {
    if (isExpired(record, days, now)) { await store.delete(record.id); removed += 1; }
  }
  return removed;
}

/**
 * Auto-delete. `start()` purges once (call it right after the store opens) and then every
 * `intervalMs` while the app stays open; `skip()` is for a store that could not open.
 * `count()` and `ready()` wait until start-up has purged (or skipped) and for any running purge,
 * so no count ever includes expired sessions.
 */
export function createRetention({ history, getDays, now = Date.now, timers = globalThis, intervalMs = 15 * 60 * 1000 }) {
  let opened;
  let running = new Promise((resolve) => { opened = resolve; });
  let interval = 0;
  const purge = () => {
    running = running.catch(() => 0).then(() => purgeExpired(history, getDays(), now())).catch(() => 0);
    return running;
  };
  return {
    purge,
    start() {
      timers.clearInterval(interval);
      interval = timers.setInterval(purge, intervalMs);
      const first = Promise.resolve().then(() => purgeExpired(history, getDays(), now())).catch(() => 0);
      running = first;
      // Anything that asked before start-up (a count, the drawer) continues after the first purge.
      first.then(() => opened());
      return first;
    },
    skip() { opened(); running = Promise.resolve(0); },
    stop() { timers.clearInterval(interval); interval = 0; },
    ready: () => running.then(() => undefined),
    async count() { await running; return history.count(); },
  };
}

/**
 * Debounced, ordered saving of the open session, with deletes that stick:
 * - `schedule()` saves after `delayMs`; `save()` saves now. Saves run one after another.
 * - `remove(id, { current })` / `removeAll()` cancel a scheduled save, wait for a running one,
 *   then delete. Deleting the open session holds saving, so neither a late timer nor the next
 *   state change re-saves it under a new id.
 * - `changed()` (a new change by the user) and `release()` (another session opened or started)
 *   lift the hold.
 */
export function createHistorySaver({ history, getSession, canSave, onSaved = () => {}, onError = () => {}, timers = globalThis, delayMs = 700 }) {
  let timer = 0;
  let chain = Promise.resolve();
  let held = false;
  const cancel = () => { timers.clearTimeout(timer); timer = 0; };
  function save() {
    cancel();
    const session = getSession();
    if (held || !canSave(session)) return chain;
    const id = session.id || newSessionId();
    const record = toRecord(session, { id });
    chain = chain.then(() => history.put(record)).then(() => onSaved(id, session), (error) => onError(error));
    return chain;
  }
  async function settle() {
    cancel();
    await chain.catch(() => {});
  }
  function schedule() {
    if (held) return;
    cancel();
    timer = timers.setTimeout(save, delayMs);
  }
  return {
    schedule,
    save,
    settle,
    async remove(id, { current = false } = {}) {
      await settle();
      if (current) held = true;
      await history.delete(id);
    },
    async removeAll() {
      await settle();
      held = true;
      await history.clear();
    },
    changed() { held = false; schedule(); },
    release() { held = false; },
    get held() { return held; },
  };
}

/** A short title for the list: the first chief-complaint line, else the first words spoken. */
export function sessionTitle(session) {
  const cc = session.note?.sections?.chief_complaint?.find((item) => String(item.text).trim());
  const text = cc ? cc.text : session.turns?.find((turn) => String(turn.text).trim())?.text || '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > 90 ? `${clean.slice(0, 87).trimEnd()}...` : clean;
}

let counter = 0;
export function newSessionId(now = Date.now()) {
  counter += 1;
  return `h${now.toString(36)}${counter.toString(36)}`;
}

// Statement provenance (origin, verifiedText) is kept so an edited or clinician-entered line still
// reads that way after reopening. Records from before provenance existed load as model lines with
// no verified text, which the workspace shows as edited (re-check) rather than grounded.
function statementRecord({ id, text, evidence, origin, verifiedText }) {
  const record = { id, text, evidence: [...evidence], origin: origin === 'clinician' ? 'clinician' : 'model' };
  if (record.origin === 'model' && typeof verifiedText === 'string') record.verifiedText = verifiedText;
  return record;
}

/** Copies only encounter fields into a storable record. */
export function toRecord(session, { id, now = new Date() } = {}) {
  const at = now.toISOString();
  const note = session.note
    ? {
      sections: Object.fromEntries(SECTIONS.map((key) => [key, (session.note.sections[key] || []).map(statementRecord)])),
      flags: session.note.flags.map(({ id: fid, type, text, evidence, resolved }) => ({ id: fid, type, text, evidence: [...evidence], resolved: Boolean(resolved) })),
    }
    : null;
  return {
    id: id || session.id || newSessionId(now.getTime()),
    title: sessionTitle(session),
    createdAt: session.createdAt || at,
    updatedAt: at,
    durationSec: Number.isFinite(session.durationSec) ? session.durationSec : null,
    source: session.source,
    labels: session.labels,
    speakersOn: session.speakersOn !== false,
    turns: session.turns.map(({ id: tid, speaker, text, start, end, diarSpeaker, aiSpeaker }) => {
      const turn = { id: tid, speaker, text, start: start ?? null, end: end ?? null };
      if (diarSpeaker !== undefined) turn.diarSpeaker = diarSpeaker;
      if (aiSpeaker) turn.aiSpeaker = true;
      return turn;
    }),
    note,
    meta: session.meta ? { ...session.meta } : null,
    edited: Boolean(session.edited),
    staleDismissed: Boolean(session.staleDismissed),
    template: session.template || session.meta?.template || null,
    language: session.language || session.meta?.language || null,
  };
}

/** A record back into a session for the store. */
export function fromRecord(record) {
  return {
    id: record.id,
    fictional: false,
    createdAt: record.createdAt,
    source: 'history',
    durationSec: record.durationSec,
    turns: record.turns || [],
    labels: record.labels || 'none',
    speakersOn: record.speakersOn !== false,
    note: record.note ? { ...record.note, sections: Object.fromEntries(SECTIONS.map((key) => [key, (record.note.sections?.[key] || []).map(statementRecord)])) } : null,
    meta: record.meta,
    edited: Boolean(record.edited),
    staleDismissed: Boolean(record.staleDismissed),
    template: record.template,
    language: record.language,
  };
}

export function matchesQuery(record, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [record.title, record.template, ...(record.turns || []).map((turn) => turn.text)].some((text) => String(text || '').toLowerCase().includes(q));
}

export function sortRecords(records) {
  return [...records].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** In-memory store with the same interface as the IndexedDB one (tests). */
export function createMemoryHistory() {
  const map = new Map();
  return {
    async list() { return sortRecords([...map.values()].map((r) => structuredClone(r))); },
    async get(id) { return map.has(id) ? structuredClone(map.get(id)) : null; },
    async put(record) { map.set(record.id, structuredClone(record)); return record.id; },
    async delete(id) { map.delete(id); },
    async clear() { map.clear(); },
    async count() { return map.size; },
  };
}

/** IndexedDB store. Rejects (once) if IndexedDB is missing or blocked. */
export function createIdbHistory(idb = globalThis.indexedDB) {
  let opening = null;
  const open = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!idb) { reject(new Error('IndexedDB unavailable')); return; }
        let request;
        try { request = idb.open(DB_NAME, 1); } catch (error) { reject(error); return; }
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      const request = fn(store);
      if (request) request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    available: Boolean(idb),
    open,
    async list() { return sortRecords((await run('readonly', (s) => s.getAll())) || []); },
    async get(id) { return (await run('readonly', (s) => s.get(id))) ?? null; },
    async put(record) { await run('readwrite', (s) => s.put(record)); return record.id; },
    async delete(id) { await run('readwrite', (s) => s.delete(id)); },
    async clear() { await run('readwrite', (s) => s.clear()); },
    async count() { return (await run('readonly', (s) => s.count())) || 0; },
    /** Closes and deletes the whole database ("Delete everything"). */
    async destroy() {
      try { (await opening)?.close(); } catch { /* not open */ }
      opening = null;
      if (!idb) return;
      await new Promise((resolve) => {
        const request = idb.deleteDatabase(DB_NAME);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { safeStorage, memoryStorage } from '../web/assets/js/app/storage.js';
import { createVault, LIST_KEY, KEY_PREFIX, sanitizeRecord, describeRecord } from '../web/assets/js/app/connections.js';
import { createMemoryHistory, isExpired, purgeExpired, toRecord, fromRecord, matchesQuery, sessionTitle, createHistorySaver, createRetention } from '../web/assets/js/app/history.js';
import { emptySession } from '../web/assets/js/app/store.js';

const stores = () => {
  const localRaw = memoryStorage();
  const sessionRaw = memoryStorage();
  return { localRaw, sessionRaw, local: safeStorage(() => localRaw), session: safeStorage(() => sessionRaw) };
};

test('safeStorage falls back to memory when storage is blocked and never throws', () => {
  const blocked = safeStorage(() => { throw new DOMException('denied', 'SecurityError'); });
  assert.equal(blocked.persistent, false);
  assert.equal(blocked.set('a', '1'), false);
  assert.equal(blocked.get('a'), '1');
  assert.deepEqual(blocked.keys(), ['a']);
  blocked.remove('a');
  assert.equal(blocked.get('a'), null);
  const full = memoryStorage();
  full.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  const s = safeStorage(() => ({ ...full, setItem: (k) => { if (k !== '__scribe_probe__') throw new Error('quota'); }, removeItem() {}, getItem: () => null, length: 0, key: () => null }));
  assert.equal(s.persistent, true);
  assert.equal(s.set('x', 'y'), false, 'a failed write is kept in memory');
  assert.equal(s.get('x'), 'y');
  assert.equal(s.getJSON('missing', 5), 5);
});

test('keys are kept for this tab by default and on the device only when remembered; metadata never holds a key', () => {
  const { local, session, localRaw, sessionRaw } = stores();
  const vault = createVault({ local, session });
  vault.save({ id: 'c1', provider: 'openai', name: 'Mine', remember: 'session' }, 'sk-tab-only');
  vault.save({ id: 'c2', provider: 'anthropic', name: 'Claude', remember: 'device' }, 'sk-ant-remembered');
  assert.equal(sessionRaw.getItem(`${KEY_PREFIX}c1`), 'sk-tab-only');
  assert.equal(localRaw.getItem(`${KEY_PREFIX}c1`), null);
  assert.equal(localRaw.getItem(`${KEY_PREFIX}c2`), 'sk-ant-remembered');
  assert.equal(sessionRaw.getItem(`${KEY_PREFIX}c2`), null);
  const listJson = localRaw.getItem(LIST_KEY);
  assert.ok(!listJson.includes('sk-'), 'the connection list must not contain keys');
  assert.deepEqual(vault.list().map((c) => [c.id, c.hasKey]), [['c1', true], ['c2', true]]);
  assert.deepEqual(vault.connection('c1'), { provider: 'openai', apiKey: 'sk-tab-only' });
  assert.equal(vault.rememberedCount(), 1);

  // A new tab: sessionStorage is empty, localStorage persists.
  const nextTab = createVault({ local: safeStorage(() => localRaw), session: safeStorage(() => memoryStorage()) });
  assert.deepEqual(nextTab.list().map((c) => [c.id, c.hasKey, c.keyed]), [['c1', false, true], ['c2', true, true]]);
});

test('changing the remember choice moves the existing key; empty string removes it; remove and clearAll erase everything', () => {
  const { local, session, localRaw, sessionRaw } = stores();
  const vault = createVault({ local, session });
  vault.save({ id: 'c1', provider: 'openai', remember: 'session' }, 'sk-1');
  vault.save({ id: 'c1', provider: 'openai', remember: 'device' });
  assert.equal(localRaw.getItem(`${KEY_PREFIX}c1`), 'sk-1');
  assert.equal(sessionRaw.getItem(`${KEY_PREFIX}c1`), null);
  vault.save({ id: 'c1', provider: 'openai', remember: 'session' });
  assert.equal(sessionRaw.getItem(`${KEY_PREFIX}c1`), 'sk-1');
  assert.equal(localRaw.getItem(`${KEY_PREFIX}c1`), null);
  vault.save({ id: 'c1', provider: 'openai', remember: 'session' }, '');
  assert.equal(vault.list()[0].hasKey, false);
  vault.save({ id: 'c2', provider: 'groq', remember: 'device' }, 'gsk');
  vault.remove('c2');
  assert.equal(localRaw.getItem(`${KEY_PREFIX}c2`), null);
  vault.save({ id: 'c3', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', remember: 'device' });
  assert.deepEqual(vault.connection('c3'), { provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1' });
  vault.save({ id: 'c4', provider: 'mistral', remember: 'device' }, 'mk');
  vault.clearAll();
  assert.equal(localRaw.length, 0);
  assert.equal(sessionRaw.length, 0);
});

test('stored records are sanitised: unknown providers, bad ids and smuggled keys are dropped', () => {
  assert.equal(sanitizeRecord({ id: '../x', provider: 'openai' }), null);
  assert.equal(sanitizeRecord({ id: 'c1', provider: 'evil' }), null);
  const clean = sanitizeRecord({ id: 'c1', provider: 'openai', apiKey: 'sk-secret', baseUrl: 'https://evil.example', remember: 'forever' });
  assert.deepEqual(clean, { id: 'c1', provider: 'openai', name: 'OpenAI', baseUrl: '', remember: 'session', keyed: false });
  const t = (key, vars) => `${key}:${vars.provider}`;
  assert.equal(describeRecord({ provider: 'openai', hasKey: true, remember: 'device' }, t), 'app.conn.detailDevice:OpenAI');
  assert.equal(describeRecord({ provider: 'openai', hasKey: false }, t), 'app.conn.detailNoKey:OpenAI');
  assert.equal(describeRecord({ provider: 'custom', baseUrl: 'https://x/v1' }, t), 'https://x/v1');
  assert.equal(describeRecord({ provider: 'custom', baseUrl: 'https://x/v1', keyed: true, hasKey: false }, t), 'app.conn.detailNoKey:https://x/v1', 'an optional key that was saved for one tab is reported missing');
});

test('history auto-delete removes only sessions older than the retention period; 0 keeps them', async () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const day = 864e5;
  assert.equal(isExpired({ updatedAt: new Date(now - 2 * day).toISOString() }, 1, now), true);
  assert.equal(isExpired({ updatedAt: new Date(now - 2 * day).toISOString() }, 7, now), false);
  assert.equal(isExpired({ updatedAt: new Date(now - 400 * day).toISOString() }, 0, now), false);
  assert.equal(isExpired({ updatedAt: 'garbage' }, 7, now), true);
  const store = createMemoryHistory();
  await store.put({ id: 'old', updatedAt: new Date(now - 8 * day).toISOString() });
  await store.put({ id: 'new', updatedAt: new Date(now - 1 * day).toISOString() });
  assert.equal(await purgeExpired(store, 0, now), 0);
  assert.equal(await purgeExpired(store, 7, now), 1);
  assert.deepEqual((await store.list()).map((r) => r.id), ['new']);
});

test('history records keep encounter content only, round-trip into a session and are searchable', () => {
  const session = {
    ...emptySession(), createdAt: '2026-11-17T10:00:00.000Z', source: 'paste', durationSec: 61, labels: 'source',
    turns: [{ id: 't1', speaker: 'patient', text: 'I have had a headache for three days.', start: null, end: null, junk: 'x' }],
    note: { sections: { chief_complaint: [{ id: 's1', text: 'Headache for three days.', evidence: ['headache for three days'] }], subjective: [], objective: [], assessment: [], plan: [] }, flags: [] },
    meta: { provider: 'custom', model: 'm', template: 'general', language: 'en', transcriptHash: 'h' },
  };
  const record = toRecord(session, { id: 'h1', now: new Date('2026-11-17T10:05:00Z') });
  assert.equal(record.title, 'Headache for three days.');
  assert.equal(record.updatedAt, '2026-11-17T10:05:00.000Z');
  assert.equal(record.turns[0].junk, undefined);
  assert.ok(!JSON.stringify(record).includes('apiKey'));
  const back = fromRecord(record);
  assert.equal(back.id, 'h1');
  assert.equal(back.source, 'history');
  assert.deepEqual(back.note, record.note);
  assert.equal(matchesQuery(record, 'HEADACHE'), true);
  assert.equal(matchesQuery(record, 'migraine'), false);
  assert.equal(sessionTitle({ turns: [{ text: 'x'.repeat(200) }] }).length, 90);
});

test('history keeps statement provenance; records saved before it existed fail safe as edited', () => {
  const session = {
    ...emptySession(), createdAt: '2026-11-17T10:00:00.000Z', source: 'paste', labels: 'source',
    turns: [{ id: 't1', speaker: 'patient', text: 'Headache for three days.', start: null, end: null }],
    note: { sections: { chief_complaint: [{ id: 's1', text: 'Headache, three days.', evidence: ['headache for three days'], origin: 'model', verifiedText: 'Headache for three days.' }], subjective: [{ id: 's2', text: 'Typed.', evidence: [], origin: 'clinician' }], objective: [], assessment: [], plan: [] }, flags: [] },
    meta: { provider: 'custom', model: 'm', template: 'general', language: 'en', transcriptHash: 'h' },
  };
  const back = fromRecord(toRecord(session, { id: 'h1' }));
  assert.deepEqual(back.note.sections.chief_complaint[0], session.note.sections.chief_complaint[0]);
  assert.deepEqual(back.note.sections.subjective[0], session.note.sections.subjective[0]);
  const legacy = fromRecord({ ...toRecord(session, { id: 'h2' }), note: { sections: { chief_complaint: [{ id: 'x', text: 'Old line.', evidence: ['headache'] }], subjective: [], objective: [], assessment: [], plan: [] }, flags: [] } });
  assert.equal(legacy.note.sections.chief_complaint[0].origin, 'model');
  assert.equal(legacy.note.sections.chief_complaint[0].verifiedText, undefined, 'unknown verified text: shown as edited until regenerated');
});

// ---------- Saving controller and retention ----------
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn, ms) { const id = next++; const tick = () => { pending.set(id, { fn: () => { fn(); tick(); }, at: now + ms }); }; tick(); return id; },
    clearInterval(id) { pending.delete(id); },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        due[1].fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

const savedSession = (id = null) => ({ ...emptySession(id), createdAt: '2026-11-17T10:00:00.000Z', turns: [{ id: 't1', speaker: 'patient', text: 'Headache.', start: null, end: null }] });

test('deleting the open session cancels its scheduled save, waits for a running one, and nothing re-saves it until a new change', async () => {
  const timers = fakeTimers();
  const history = createMemoryHistory();
  let release;
  const slowPut = history.put;
  let session = savedSession();
  const saved = [];
  const saver = createHistorySaver({ history, getSession: () => session, canSave: () => true, onSaved: (id) => { saved.push(id); session = { ...session, id }; }, timers, delayMs: 700 });
  // A scheduled (debounced) save is cancelled by the delete.
  saver.schedule();
  await saver.remove('whatever', { current: true });
  await timers.advance(1000);
  assert.equal(await history.count(), 0, 'scheduled save cancelled');
  saver.schedule();
  await timers.advance(1000);
  assert.equal(await history.count(), 0, 'no re-save without a new change');
  // A new change re-enables saving.
  saver.changed();
  await timers.advance(1000);
  assert.equal(await history.count(), 1);
  const id = saved.at(-1);
  // A running save finishes before the delete, so the record cannot reappear afterwards.
  history.put = (record) => new Promise((resolve) => { release = () => resolve(slowPut(record)); });
  const running = saver.save();
  const removal = saver.remove(id, { current: true });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await running;
  await removal;
  history.put = slowPut;
  assert.equal(await history.count(), 0, 'in-flight save did not resurrect the deleted session');
  saver.schedule();
  await timers.advance(1000);
  assert.equal(await history.count(), 0);
  // Delete all behaves the same; a new or loaded session releases the hold.
  saver.changed();
  await timers.advance(1000);
  assert.equal(await history.count(), 1);
  saver.schedule();
  await saver.removeAll();
  await timers.advance(1000);
  assert.equal(await history.count(), 0);
  saver.release();
  saver.schedule();
  await timers.advance(1000);
  assert.equal(await history.count(), 1);
});

test('expired sessions are purged at start-up before any count, and periodically while the app stays open', async () => {
  const timers = fakeTimers();
  const history = createMemoryHistory();
  const day = 864e5;
  let now = Date.parse('2026-11-17T12:00:00Z');
  await history.put({ id: 'old', updatedAt: new Date(now - 8 * day).toISOString() });
  await history.put({ id: 'fresh', updatedAt: new Date(now - 6.9 * day).toISOString() });
  const retention = createRetention({ history, getDays: () => 7, now: () => now, timers, intervalMs: 60 * 60 * 1000 });
  const early = retention.count(); // asked before the store finished opening
  await retention.start();
  assert.equal(await early, 1, 'even a count requested before start-up excludes expired sessions');
  assert.equal(await retention.count(), 1);
  assert.deepEqual((await history.list()).map((r) => r.id), ['fresh']);
  now += 0.2 * day;
  await timers.advance(60 * 60 * 1000);
  await retention.ready();
  assert.equal(await history.count(), 0, 'purged again while the app stays open');
  retention.stop();
});

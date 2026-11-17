import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, reducer, initialState, emptySession } from '../web/assets/js/app/store.js';
import { sanitizePrefs, vocabularyList, DEFAULT_PREFS } from '../web/assets/js/app/prefs.js';
import { resolveSelection, targetsFor, filterModels, defaultModelFor } from '../web/assets/js/app/selection.js';
import { publicConfig } from '../lib/config.js';

const note = () => ({
  sections: { chief_complaint: [{ id: 'a', text: 'Headache.', evidence: ['headache'] }], subjective: [], objective: [], assessment: [], plan: [] },
  flags: [{ id: 'f1', type: 'unclear', text: 'Check.', evidence: [], resolved: false }],
});

test('store notifies subscribers only when state changes and forbids dispatch inside reducers', () => {
  const store = createStore();
  const seen = [];
  store.subscribe((state, previous, action) => seen.push(action.type));
  store.dispatch({ type: 'unknown/action' });
  store.dispatch({ type: 'capture/method', method: 'paste' });
  assert.deepEqual(seen, ['capture/method']);
  assert.equal(store.getState().capture.method, 'paste');
  const bad = createStore(() => { bad.dispatch({ type: 'x' }); return {}; }, {});
  assert.throws(() => bad.dispatch({ type: 'y' }), /Reducers may not dispatch/);
});

test('switching capture method clears an error or denied state but not an active recording', () => {
  let state = reducer(initialState(), { type: 'capture/state', state: 'denied' });
  state = reducer(state, { type: 'capture/method', method: 'upload' });
  assert.equal(state.capture.state, 'idle');
  state = reducer(state, { type: 'capture/state', state: 'recording' });
  assert.equal(reducer(state, { type: 'capture/method', method: 'paste' }).capture.state, 'recording');
});

test('note lifecycle: generating, ready, edits mark the draft edited, cancel restores the previous draft', () => {
  let state = reducer(initialState(), { type: 'transcript/set', turns: [{ id: 't1', speaker: 'patient', text: 'Headache.' }], labels: 'source', source: 'paste' });
  state = reducer(state, { type: 'note/generating', template: 'general', language: 'en' });
  assert.equal(state.noteState.state, 'generating');
  state = reducer(state, { type: 'note/cancelled' });
  assert.equal(state.noteState.state, 'empty', 'no previous draft, so cancel returns to empty');
  state = reducer(state, { type: 'note/ready', note: note(), meta: { template: 'general', language: 'en', transcriptHash: 'x' } });
  assert.equal(state.session.edited, false);
  state = reducer(state, { type: 'statement/edit', section: 'chief_complaint', id: 'a', text: 'Headache, three days.' });
  assert.equal(state.session.note.sections.chief_complaint[0].text, 'Headache, three days.');
  assert.equal(state.session.edited, true);
  state = reducer(state, { type: 'statement/add', section: 'plan', id: 'p1' });
  state = reducer(state, { type: 'statement/remove', section: 'chief_complaint', id: 'a' });
  assert.deepEqual(state.session.note.sections.plan.map((s) => s.id), ['p1']);
  assert.equal(state.session.note.sections.chief_complaint.length, 0);
  state = reducer(state, { type: 'note/generating', template: 'general', language: 'en' });
  state = reducer(state, { type: 'note/cancelled' });
  assert.equal(state.noteState.state, 'ready', 'cancel keeps the existing draft');
  state = reducer(state, { type: 'flag/resolve', id: 'f1', resolved: true });
  assert.equal(state.session.note.flags[0].resolved, true);
});

test('section regeneration replaces one section and clears the regenerating marker', () => {
  let state = reducer(initialState(), { type: 'note/ready', note: note(), meta: { template: 'general', language: 'en' } });
  state = reducer(state, { type: 'section/regenerating', section: 'plan' });
  assert.equal(state.noteState.regenerating, 'plan');
  state = reducer(state, { type: 'section/replace', section: 'plan', items: [{ id: 'n', text: 'Rest.', evidence: ['rest'] }] });
  assert.equal(state.noteState.regenerating, null);
  assert.equal(state.session.note.sections.plan[0].text, 'Rest.');
  assert.equal(state.session.note.sections.chief_complaint[0].id, 'a');
});

test('speaker change can apply a role to every unlabelled turn of the same diarized speaker', () => {
  const turns = [
    { id: 't1', speaker: 'unknown', diarSpeaker: 'A', text: 'Hello.' },
    { id: 't2', speaker: 'unknown', diarSpeaker: 'B', text: 'Hi.' },
    { id: 't3', speaker: 'unknown', diarSpeaker: 'A', text: 'How are you?' },
  ];
  let state = reducer(initialState(), { type: 'transcript/set', turns, labels: 'native' });
  state = reducer(state, { type: 'turn/speaker', id: 't1', speaker: 'doctor', applyToGroup: true });
  assert.deepEqual(state.session.turns.map((t) => t.speaker), ['doctor', 'unknown', 'doctor']);
  state = reducer(state, { type: 'turn/add', afterId: 't1', id: 'new' });
  assert.deepEqual(state.session.turns.map((t) => t.id), ['t1', 'new', 't2', 't3']);
});

test('new session clears encounter data but keeps connections and preferences; reset keeps server mode', () => {
  let state = initialState({ connections: [{ id: 'c1', provider: 'openai', name: 'OpenAI', hasKey: true }] });
  state = reducer(state, { type: 'prefs/set', patch: { template: 'neurology', speakers: false } });
  state = reducer(state, { type: 'transcript/set', turns: [{ id: 't', speaker: 'unknown', text: 'x' }] });
  state = reducer(state, { type: 'session/new' });
  assert.deepEqual(state.session.turns, []);
  assert.equal(state.session.speakersOn, false, 'new sessions follow the speaker-label default');
  assert.equal(state.prefs.template, 'neurology');
  assert.equal(state.connections.length, 1);
  state = reducer(state, { type: 'mode/server', config: { mode: 'server' } });
  state = reducer(state, { type: 'reset/all' });
  assert.equal(state.mode, 'server');
  assert.equal(state.prefs.template, 'general');
  assert.deepEqual(state.session, emptySession());
});

test('preferences are sanitised: unknown templates, languages and retention fall back to safe defaults', () => {
  assert.deepEqual(sanitizePrefs(null), { ...DEFAULT_PREFS, selection: DEFAULT_PREFS.selection });
  const prefs = sanitizePrefs({ template: 'internal', noteLanguage: 'xx', autoDeleteDays: '30', history: 'yes', selection: { note: { connectionId: 'c1', model: ' m ' } } }, 'id');
  assert.equal(prefs.template, 'general');
  assert.equal(prefs.noteLanguage, 'id', 'follows the interface language when unset');
  assert.equal(prefs.autoDeleteDays, 30);
  assert.equal(prefs.history, false, 'history needs an explicit true');
  assert.deepEqual(prefs.selection.note, { connectionId: 'c1', model: 'm' });
  assert.equal(sanitizePrefs({ template: 'internal_medicine' }).template, 'internal_medicine');
  assert.equal(sanitizePrefs({ template: 'follow_up' }).template, 'follow_up');
});

test('vocabulary splits on commas, semicolons and lines, de-duplicates and respects engine limits', () => {
  assert.deepEqual(vocabularyList('levetiracetam, Tinel\'s sign\nEMG; emg ,, '), ['levetiracetam', 'Tinel\'s sign', 'EMG']);
  assert.equal(vocabularyList(Array.from({ length: 400 }, (_, i) => `term${i}`).join(',')).length, 300);
  assert.deepEqual(vocabularyList(`${'x'.repeat(101)},ok`), ['ok']);
});

test('model selection keeps a valid saved choice, otherwise picks a capable usable connection and its balanced default', () => {
  const connections = [
    { id: 'dg', provider: 'deepgram', name: 'Deepgram', hasKey: true },
    { id: 'an', provider: 'anthropic', name: 'Claude', hasKey: false },
    { id: 'oa', provider: 'openai', name: 'OpenAI', hasKey: true },
  ];
  assert.deepEqual(targetsFor('note', connections).map((t) => t.id), ['an', 'oa'], 'Deepgram cannot write notes');
  assert.deepEqual(targetsFor('transcription', connections).map((t) => t.id), ['dg', 'oa'], 'Anthropic cannot transcribe');
  assert.deepEqual(resolveSelection('note', null, connections), { connectionId: 'oa', model: 'gpt-6.1-terra' }, 'skips the connection without a key');
  assert.deepEqual(resolveSelection('note', { connectionId: 'an', model: 'claude-x' }, connections), { connectionId: 'an', model: 'claude-x' });
  assert.deepEqual(resolveSelection('note', { connectionId: 'dg', model: 'nova-3' }, connections), { connectionId: 'oa', model: 'gpt-6.1-terra' }, 'a saved choice that cannot do the role is replaced');
  assert.deepEqual(resolveSelection('transcription', { connectionId: 'gone', model: 'x' }, connections), { connectionId: 'dg', model: 'nova-3-medical' });
  assert.deepEqual(resolveSelection('note', null, []), { connectionId: null, model: '' });
  assert.equal(defaultModelFor({ kind: 'byok', provider: 'anthropic' }, 'note'), 'claude-sonnet-5-5');
});

test('server targets come from /api/config and only when configured', () => {
  const config = {
    mode: 'server',
    providers: [{ id: 'openai', label: 'OpenAI', configured: true, default_model: 'gpt-6.1-terra', suggested_models: ['a'] }, { id: 'groq', configured: false }],
    transcription: { configured: true, provider: 'openai', default_model: 'gpt-transcribe', diarization: true },
  };
  assert.deepEqual(targetsFor('note', [], config).map((t) => t.id), ['server:openai']);
  assert.deepEqual(resolveSelection('transcription', null, [], config), { connectionId: 'server:transcription', model: 'gpt-transcribe' });
  assert.deepEqual(targetsFor('note', [], { ...config, providers: [] }), []);
});

test('server mode defaults to each provider\'s balanced model, not the most expensive one', () => {
  const config = publicConfig({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', MISTRAL_API_KEY: 'k' });
  const byId = Object.fromEntries(config.providers.map((p) => [p.id, p.default_model]));
  assert.equal(byId.openai, 'gpt-6.1-terra');
  assert.equal(byId.anthropic, 'claude-sonnet-5-5');
  assert.equal(byId.gemini, 'gemini-3.8-flash');
  assert.equal(byId.mistral, 'mistral-medium-latest');
  assert.equal(publicConfig({ ANTHROPIC_MODEL: 'claude-opus-5-5' }).providers.find((p) => p.id === 'anthropic').default_model, 'claude-opus-5-5', 'an explicit *_MODEL still wins');
});

test('model search puts prefix matches first and matches labels', () => {
  const models = [{ id: 'gpt-6.1-sol' }, { id: 'o-gpt' }, { id: 'claude', label: 'Claude Sonnet' }];
  assert.deepEqual(filterModels(models, 'gpt').map((m) => m.id), ['gpt-6.1-sol', 'o-gpt']);
  assert.deepEqual(filterModels(models, 'sonnet').map((m) => m.id), ['claude']);
  assert.equal(filterModels(models, '').length, 3);
});

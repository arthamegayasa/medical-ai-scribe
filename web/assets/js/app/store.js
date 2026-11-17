// One predictable store: state changes only through `dispatch(action)` and the pure `reducer`.
// Views subscribe and render; async work lives in controllers that dispatch results.
import { DEFAULT_PREFS, sanitizePrefs } from './prefs.js';
import { SECTIONS } from '../../../core/soap/schema.js';

export function emptySession(id = null) {
  return {
    id,                    // history id once saved; null otherwise
    fictional: false,
    createdAt: null,
    source: null,          // 'record' | 'upload' | 'paste' | 'example' | 'history'
    durationSec: null,
    turns: [],
    labels: 'none',        // 'none' | 'source' (pasted labels) | 'native' (diarized) | 'ai' (suggested) | 'manual'
    speakersOn: true,
    note: null,            // { sections: { [section]: [{ id, text, evidence }] }, flags: [{ id, type, text, evidence, resolved }] }
    meta: null,            // engine meta (provider, model, template, language, generatedAt, transcriptHash)
    edited: false,         // the clinician changed the draft after generation
    staleDismissed: false,
    template: null,
    language: null,
  };
}

export function initialState(overrides = {}) {
  return {
    mode: 'byok',
    server: null,          // public /api/config when the server offers providers
    accessToken: '',       // server access token is never persisted beyond the tab (kept in memory)
    connections: [],       // records with hasKey, never keys
    connectionStatus: {},  // id -> 'ok' | 'error' | 'untested'
    prefs: sanitizePrefs(DEFAULT_PREFS),
    session: emptySession(),
    capture: { state: 'idle', method: 'record', error: null, progress: null, failedSegment: null },
    noteState: { state: 'empty', error: null, regenerating: null },
    historyAvailable: true,
    ...overrides,
  };
}

const mapSections = (note, fn) => ({ ...note, sections: Object.fromEntries(SECTIONS.map((key) => [key, fn(key, note.sections[key] || [])])) });

function editSession(state, patch) {
  return { ...state, session: { ...state.session, ...patch } };
}

function editNote(state, fn) {
  if (!state.session.note) return state;
  return editSession(state, { note: fn(state.session.note), edited: true });
}

export function reducer(state, action) {
  switch (action.type) {
    case 'mode/server':
      return { ...state, mode: action.config ? 'server' : 'byok', server: action.config || null };
    case 'access/token':
      return { ...state, accessToken: String(action.token || '') };
    case 'connections/set':
      return { ...state, connections: action.connections };
    case 'connection/status':
      return { ...state, connectionStatus: { ...state.connectionStatus, [action.id]: action.status } };
    case 'prefs/set':
      return { ...state, prefs: sanitizePrefs({ ...state.prefs, ...action.patch }) };
    case 'selection/set':
      return { ...state, prefs: sanitizePrefs({ ...state.prefs, selection: { ...state.prefs.selection, [action.role]: { connectionId: action.connectionId, model: action.model } } }) };
    case 'history/available':
      return { ...state, historyAvailable: Boolean(action.available) };

    case 'capture/method':
      return { ...state, capture: { ...state.capture, method: action.method, state: ['error', 'denied'].includes(state.capture.state) ? 'idle' : state.capture.state } };
    case 'capture/state':
      return { ...state, capture: { ...state.capture, state: action.state, error: action.error ?? null, progress: action.progress ?? null, failedSegment: action.failedSegment ?? null } };
    case 'capture/progress':
      return { ...state, capture: { ...state.capture, progress: action.progress } };

    case 'session/new':
      return { ...state, session: { ...emptySession(), speakersOn: state.prefs.speakers }, capture: { ...state.capture, state: 'idle', error: null, progress: null, failedSegment: null }, noteState: { state: 'empty', error: null, regenerating: null } };
    case 'session/load': {
      const session = { ...emptySession(), ...action.session };
      return { ...state, session, capture: { ...state.capture, state: 'idle', error: null, progress: null, failedSegment: null }, noteState: { state: session.note ? 'ready' : 'empty', error: null, regenerating: null } };
    }
    case 'session/saved':
      return editSession(state, { id: action.id });
    case 'transcript/set':
      return {
        ...editSession(state, {
          turns: action.turns, labels: action.labels || 'none', source: action.source ?? state.session.source,
          durationSec: action.durationSec ?? state.session.durationSec, createdAt: state.session.createdAt || action.at || null,
        }),
        capture: { ...state.capture, state: 'idle', error: null, progress: null, failedSegment: null },
      };
    case 'transcript/clear':
      return { ...editSession(state, { turns: [], labels: 'none' }) };
    case 'turn/edit':
      return editSession(state, { turns: state.session.turns.map((turn) => (turn.id === action.id ? { ...turn, text: action.text } : turn)) });
    case 'turn/speaker': {
      const target = state.session.turns.find((turn) => turn.id === action.id);
      const applyToGroup = action.applyToGroup && target?.diarSpeaker !== undefined;
      const turns = state.session.turns.map((turn) => {
        if (turn.id === action.id) return { ...turn, speaker: action.speaker, aiSpeaker: false };
        if (applyToGroup && turn.diarSpeaker === target.diarSpeaker && turn.speaker === 'unknown') return { ...turn, speaker: action.speaker, aiSpeaker: false };
        return turn;
      });
      return editSession(state, { turns, labels: state.session.labels === 'none' ? 'manual' : state.session.labels });
    }
    case 'turn/add': {
      const turns = [...state.session.turns];
      const index = action.afterId ? turns.findIndex((turn) => turn.id === action.afterId) + 1 : turns.length;
      turns.splice(index || turns.length, 0, { id: action.id, speaker: action.speaker || 'unknown', text: action.text || '', start: null, end: null });
      return editSession(state, { turns });
    }
    case 'turn/remove':
      return editSession(state, { turns: state.session.turns.filter((turn) => turn.id !== action.id) });
    case 'speakers/toggle':
      return editSession(state, { speakersOn: Boolean(action.on) });

    case 'note/generating':
      return { ...state, noteState: { state: 'generating', error: null, regenerating: null }, session: { ...state.session, template: action.template, language: action.language } };
    case 'note/ready':
      return {
        ...editSession(state, { note: action.note, meta: action.meta, edited: false, staleDismissed: false, template: action.meta.template, language: action.meta.language, fictional: action.fictional ?? state.session.fictional }),
        noteState: { state: 'ready', error: null, regenerating: null },
      };
    case 'note/error':
      return { ...state, noteState: { state: 'error', error: action.error, regenerating: null } };
    case 'note/cancelled':
      return { ...state, noteState: { state: state.session.note ? 'ready' : 'empty', error: null, regenerating: null } };
    case 'note/clear':
      return { ...editSession(state, { note: null, meta: null, edited: false, staleDismissed: false }), noteState: { state: 'empty', error: null, regenerating: null } };

    case 'statement/edit':
      return editNote(state, (note) => mapSections(note, (key, items) => (key === action.section ? items.map((item) => (item.id === action.id ? { ...item, text: action.text } : item)) : items)));
    case 'statement/add':
      return editNote(state, (note) => mapSections(note, (key, items) => (key === action.section ? [...items, { id: action.id, text: action.text || '', evidence: [] }] : items)));
    case 'statement/remove':
      return editNote(state, (note) => mapSections(note, (key, items) => (key === action.section ? items.filter((item) => item.id !== action.id) : items)));
    case 'section/regenerating':
      return { ...state, noteState: { ...state.noteState, regenerating: action.section } };
    case 'section/replace':
      return {
        ...editSession(state, { note: mapSections(state.session.note, (key, items) => (key === action.section ? action.items : items)) }),
        noteState: { ...state.noteState, regenerating: null },
      };
    case 'section/done':
      return { ...state, noteState: { ...state.noteState, regenerating: null } };
    case 'flag/resolve':
      if (!state.session.note) return state;
      return editSession(state, { note: { ...state.session.note, flags: state.session.note.flags.map((flag) => (flag.id === action.id ? { ...flag, resolved: Boolean(action.resolved) } : flag)) } });
    case 'stale/dismiss':
      return editSession(state, { staleDismissed: true });

    case 'reset/all':
      return initialState({ historyAvailable: state.historyAvailable, mode: state.mode, server: state.server });
    default:
      return state;
  }
}

export function createStore(reduce = reducer, state = initialState()) {
  const listeners = new Set();
  let dispatching = false;
  return {
    getState: () => state,
    dispatch(action) {
      if (dispatching) throw new Error('Reducers may not dispatch actions.');
      const previous = state;
      dispatching = true;
      try { state = reduce(state, action); } finally { dispatching = false; }
      if (state !== previous) for (const listener of [...listeners]) listener(state, previous, action);
      return action;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

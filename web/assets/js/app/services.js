// Engine calls for the selected targets. BYOK targets call the provider from the browser with the
// key read from the vault at request time; server targets call this deployment's /api.
import * as core from '../../../core/index.js';
import { AppError } from './messages.js';
import { createSegmentJob } from './segments.js';
import { purposeFor } from './selection.js';

export function createServices({ store, vault }) {
  const server = () => core.createServerClient({ accessToken: store.getState().accessToken });

  /** Resolves the selected target for a role, or throws an AppError the UI can explain. */
  function target(role) {
    const state = store.getState();
    const { connectionId, model } = state.prefs.selection[role];
    if (!connectionId) throw new AppError(role === 'note' ? 'noConnection' : 'noTranscriptionConnection');
    if (connectionId.startsWith('server:')) {
      if (!state.server) throw new AppError(role === 'note' ? 'noConnection' : 'noTranscriptionConnection');
      const provider = connectionId.slice('server:'.length);
      const label = provider === 'transcription' ? state.server.transcription?.provider || 'server' : (state.server.providers.find((p) => p.id === provider)?.label || provider);
      return { kind: 'server', provider, model: model || undefined, label, preset: null };
    }
    const record = state.connections.find((item) => item.id === connectionId);
    if (!record) throw new AppError(role === 'note' ? 'noConnection' : 'noTranscriptionConnection');
    const preset = core.getProvider(record.provider);
    const connection = vault.connection(connectionId);
    if ((preset.keyRequired || record.keyed) && !connection?.apiKey) throw new AppError('noKey');
    if (!model) throw new AppError('noModel');
    return { kind: 'byok', connection, model, label: record.name, preset, connectionId };
  }

  /** Context for error messages (CORS guidance needs to know the endpoint kind). */
  function errorContext(role) {
    try {
      const t = target(role);
      return { browser: t.preset?.browser ?? null, providerLabel: t.label, origin: location.origin };
    } catch {
      return { origin: location.origin };
    }
  }

  function hasTarget(role) {
    try { target(role); return true; } catch { return false; }
  }

  async function generateNote({ transcript, language, template, onPartial, signal }) {
    const t = target('note');
    if (t.kind === 'server') {
      const result = await server().generateNote({ provider: t.provider, model: t.model, transcript, language, template, signal });
      return { ...result, streamed: false };
    }
    const result = await core.generateNote({ connection: t.connection, model: t.model, transcript, language, template, stream: true, onPartial, signal });
    return { ...result, streamed: true };
  }

  async function regenerateSection({ transcript, note, section, language, template, onPartial, signal }) {
    const t = target('note');
    if (t.kind === 'server') return server().regenerateSection({ provider: t.provider, model: t.model, transcript, note, section, language, template, signal });
    return core.regenerateSection({ connection: t.connection, model: t.model, transcript, note, section, language, template, stream: true, onPartial, signal });
  }

  async function labelSpeakers({ transcript, signal, onProgress }) {
    const t = target('note');
    if (t.kind === 'server') return server().labelSpeakers({ provider: t.provider, model: t.model, transcript, signal });
    return core.labelSpeakers({ connection: t.connection, model: t.model, transcript, signal, onProgress });
  }

  /** Splits audio for the selected transcription target (direct upload when it fits). */
  async function prepareAudio(blob) {
    const t = target('transcription');
    const maxUploadBytes = t.kind === 'server' ? store.getState().server.limits.audio_bytes : t.preset.maxUploadBytes;
    if (core.chooseUploadStrategy({ sizeBytes: blob.size }, { maxUploadBytes }) === 'direct') return [{ audio: blob, start: 0, end: null }];
    const { prepareSegments } = await import('../../../core/audio/decode.browser.js');
    return prepareSegments(blob, { maxUploadBytes });
  }

  /** A resumable transcription job over prepared segments. */
  function transcriptionJob(segments, { language, vocabulary, diarize, onProgress }) {
    const t = target('transcription');
    const options = { model: t.model, language, vocabulary, diarize, timestamps: true, concurrency: 1 };
    const run = (segment, index, signal) => {
      // Each segment is transcribed on its own timeline; mergeTranscripts shifts the times later.
      const one = [{ audio: segment.audio, start: 0, end: null }];
      return t.kind === 'server'
        ? server().transcribeSegments({ ...options, segments: one, signal })
        : core.transcribeSegments({ ...options, connection: t.connection, segments: one, signal });
    };
    const job = createSegmentJob({ segments, run, concurrency: 2, onProgress });
    return {
      job,
      target: t,
      merge: (results) => ({ ...core.mergeTranscripts(results, segments), model: results[0]?.model, provider: results[0]?.provider }),
    };
  }

  /** Lists models for a target. Server targets return their suggested models. */
  async function listModels(targetId, role, { signal } = {}) {
    const state = store.getState();
    if (targetId.startsWith('server:')) {
      const t = (role === 'note' ? (state.server?.providers || []).map((p) => ({ id: `server:${p.id}`, list: p.suggested_models, def: p.default_model })) : [{ id: 'server:transcription', list: [state.server?.transcription?.default_model].filter(Boolean), def: state.server?.transcription?.default_model }]).find((item) => item.id === targetId);
      const ids = [...new Set([t?.def, ...(t?.list || [])].filter(Boolean))];
      return { models: ids.map((id) => ({ id, label: id })), listed: false };
    }
    const record = state.connections.find((item) => item.id === targetId);
    if (!record) return { models: [], listed: false };
    const connection = vault.connection(targetId);
    try {
      return { models: await core.listModels(connection, { purpose: purposeFor(role), signal }), listed: true };
    } catch (error) {
      if (error?.code === 'unsupported') return { models: core.suggestedModels(record.provider, purposeFor(role)).map((id) => ({ id, label: id })), listed: false };
      throw error;
    }
  }

  return { target, hasTarget, errorContext, generateNote, regenerateSection, labelSpeakers, prepareAudio, transcriptionJob, listModels, server };
}

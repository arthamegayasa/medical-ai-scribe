// Which connection and model are used for transcription and for the note.
// A "target" is either one of the user's own connections (BYOK) or a provider configured on the
// server (server mode). Both can be offered at the same time.
import { getProvider, suggestedModels } from '../../../core/providers.js';

export const ROLES = Object.freeze(['transcription', 'note']);
const CAPABILITY = { transcription: 'transcription', note: 'chat' };
export const purposeFor = (role) => (role === 'note' ? 'chat' : 'transcription');

/** Server-held targets from `/api/config`, or [] when the server offers none. */
export function serverTargets(config, role) {
  if (!config || config.mode !== 'server') return [];
  if (role === 'transcription') {
    const t = config.transcription;
    return t?.configured ? [{ id: 'server:transcription', kind: 'server', provider: 'server', name: null, defaultModel: t.default_model || '', suggested: t.default_model ? [t.default_model] : [], diarization: Boolean(t.diarization) }] : [];
  }
  return (Array.isArray(config.providers) ? config.providers : [])
    .filter((p) => p && p.configured && typeof p.id === 'string')
    .map((p) => ({ id: `server:${p.id}`, kind: 'server', provider: p.id, name: p.label || p.id, defaultModel: p.default_model || '', suggested: Array.isArray(p.suggested_models) ? p.suggested_models : [] }));
}

/** Every target able to do `role`, BYOK connections first. */
export function targetsFor(role, connections, serverConfig) {
  const own = (connections || [])
    .filter((c) => {
      try { return getProvider(c.provider).capabilities[CAPABILITY[role]]; } catch { return false; }
    })
    .map((c) => ({ id: c.id, kind: 'byok', provider: c.provider, name: c.name, usable: Boolean(c.hasKey || (!getProvider(c.provider).keyRequired && !c.keyed)) }));
  return [...own, ...serverTargets(serverConfig, role)];
}

/** The model to start with for a target: the server default, else the preset's balanced default. */
export function defaultModelFor(target, role) {
  if (!target) return '';
  if (target.kind === 'server') return target.defaultModel || target.suggested?.[0] || '';
  const preset = getProvider(target.provider);
  if (role === 'note' && preset.defaultChatModel) return preset.defaultChatModel;
  return suggestedModels(target.provider, purposeFor(role))[0] || '';
}

/**
 * Resolves the effective `{ connectionId, model }` for a role. A saved choice wins while its
 * connection still exists and can do the job; otherwise the first usable target is chosen.
 */
export function resolveSelection(role, saved, connections, serverConfig) {
  const targets = targetsFor(role, connections, serverConfig);
  if (!targets.length) return { connectionId: null, model: '' };
  const kept = targets.find((t) => t.id === saved?.connectionId);
  if (kept) return { connectionId: kept.id, model: saved.model || defaultModelFor(kept, role) };
  const chosen = targets.find((t) => t.kind === 'server' || t.usable) || targets[0];
  return { connectionId: chosen.id, model: defaultModelFor(chosen, role) };
}

/** Orders a live model list so likely matches come first; filters by a search query. */
export function filterModels(models, query) {
  const q = String(query || '').trim().toLowerCase();
  const list = Array.isArray(models) ? models : [];
  if (!q) return list;
  const starts = [];
  const contains = [];
  for (const model of list) {
    const id = String(model.id).toLowerCase();
    const label = String(model.label || '').toLowerCase();
    if (id.startsWith(q)) starts.push(model);
    else if (id.includes(q) || label.includes(q)) contains.push(model);
  }
  return [...starts, ...contains];
}

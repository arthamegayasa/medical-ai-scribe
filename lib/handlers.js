import { ApiError, sendError } from './errors.js';
import { LIMITS, modelId, publicConfig, serverTextConnection, serverTranscriptionConnection } from './config.js';
import { guard, readJson } from './http.js';
import { decodeAudio } from './audio.js';
import { generateNote, regenerateSection } from '../web/core/soap/generate.js';
import { labelSpeakers } from '../web/core/speakers.js';
import { transcribe } from '../web/core/transcribe.js';

// A one-hour transcript plus the current note (for section regeneration), JSON-escaped.
const TEXT_BODY_LIMIT = 2 * 1024 * 1024;
const AUDIO_BODY_LIMIT = Math.ceil(LIMITS.audio_bytes / 3) * 4 + 64 * 1024;

function textRequest(body, env) {
  const { connection, defaultModel } = serverTextConnection(body.provider, env);
  return { connection, model: modelId(body.model ?? defaultModel) };
}

export function createHandlers({ env = process.env, fetchImpl = globalThis.fetch, soapTimeoutMs = 280000, audioTimeoutMs = 280000 } = {}) {
  return {
    async config(req, res) {
      try {
        guard(req, res, 'GET', env);
        return res.status(200).json(publicConfig(env));
      } catch (error) { return sendError(res, error); }
    },

    async generateSoap(req, res) {
      try {
        guard(req, res, 'POST', env, true);
        const body = await readJson(req, TEXT_BODY_LIMIT);
        if (typeof body.transcript === 'string' && body.transcript.length > LIMITS.transcript_chars) {
          throw new ApiError(413, 'transcript_too_large', `The transcript must be no longer than ${LIMITS.transcript_chars.toLocaleString('en-US')} characters.`);
        }
        const { connection, model } = textRequest(body, env);
        const options = {
          connection, model, transcript: body.transcript, language: body.language ?? 'en', template: body.template ?? 'general',
          customInstructions: body.custom_instructions ?? '', fetchImpl, timeoutMs: soapTimeoutMs,
        };
        if (body.section !== undefined) {
          const { note, items, structuredMode } = await regenerateSection({ ...options, note: body.note, section: body.section });
          return res.status(200).json({ note, items, structuredMode, section: body.section });
        }
        const result = await generateNote(options);
        // The client sees the server-facing provider id, not the engine preset behind it.
        return res.status(200).json({ note: result.note, meta: { ...result.meta, provider: body.provider } });
      } catch (error) { return sendError(res, error); }
    },

    async labelSpeakers(req, res) {
      try {
        guard(req, res, 'POST', env, true);
        const body = await readJson(req, TEXT_BODY_LIMIT);
        const { connection, model } = textRequest(body, env);
        return res.status(200).json(await labelSpeakers({ connection, model, transcript: body.transcript, fetchImpl, timeoutMs: soapTimeoutMs }));
      } catch (error) { return sendError(res, error); }
    },

    async processAudio(req, res) {
      try {
        guard(req, res, 'POST', env, true);
        const body = await readJson(req, AUDIO_BODY_LIMIT);
        const audio = decodeAudio(body.audio, body.mimeType, LIMITS.audio_bytes);
        const { connection, defaultModel } = serverTranscriptionConnection(env);
        const result = await transcribe({
          connection, model: modelId(body.model ?? defaultModel), audio, language: body.language ?? 'auto', vocabulary: body.vocabulary,
          prompt: body.prompt ?? '', diarize: body.diarize === true, timestamps: body.timestamps !== false, fetchImpl, timeoutMs: audioTimeoutMs,
        });
        return res.status(200).json({ ...result, provider: 'server' });
      } catch (error) { return sendError(res, error); }
    },
  };
}

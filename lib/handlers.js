import { ApiError, sendError } from './errors.js';
import { LIMITS, modelId, providerConfig, publicConfig } from './config.js';
import { guard, readJson } from './http.js';
import { decodeAudio, generateDraft, transcribe } from './providers.js';

export function createHandlers({ env = process.env, fetchImpl = globalThis.fetch, soapTimeoutMs = 25000, audioTimeoutMs = 50000 } = {}) {
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
        const body = await readJson(req, 128 * 1024);
        if (typeof body.transcript !== 'string' || body.transcript.trim().length < 10) {
          throw new ApiError(400, 'invalid_transcript', 'Enter a transcript with at least 10 characters.');
        }
        if (body.transcript.length > LIMITS.transcript_chars) {
          throw new ApiError(413, 'transcript_too_large', 'The transcript must be no longer than 30,000 characters.');
        }
        const language = body.language ?? 'en';
        if (!['en', 'id'].includes(language)) throw new ApiError(400, 'invalid_language', 'Choose English (en) or Bahasa Indonesia (id).');
        const provider = providerConfig(body.provider, env);
        const model = modelId(body.model ?? provider.model);
        const soap = await generateDraft({ provider, transcript: body.transcript.trim(), model, language, env, fetchImpl, timeoutMs: soapTimeoutMs });
        return res.status(200).json({ soap, provider: provider.id, model, language, draft: true });
      } catch (error) { return sendError(res, error); }
    },
    async processAudio(req, res) {
      try {
        guard(req, res, 'POST', env, true);
        const body = await readJson(req, 4 * 1024 * 1024);
        const audio = decodeAudio(body.audio, body.mimeType, LIMITS.audio_bytes);
        const language = body.language ?? 'auto';
        if (!['auto', 'en', 'id'].includes(language)) throw new ApiError(400, 'invalid_language', 'Choose auto, en or id for the audio language.');
        const model = modelId(body.model ?? env.TRANSCRIPTION_MODEL ?? 'whisper-1');
        return res.status(200).json(await transcribe({ audio, language, model, env, fetchImpl, timeoutMs: audioTimeoutMs }));
      } catch (error) { return sendError(res, error); }
    },
  };
}

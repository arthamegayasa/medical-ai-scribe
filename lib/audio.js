import { ApiError } from './errors.js';

const AUDIO_TYPES = new Set([
  'audio/webm', 'video/webm', 'audio/mp4', 'video/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/mp3', 'audio/mpga',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'application/ogg', 'audio/flac', 'audio/x-flac',
]);

/** Validates a base64 audio payload and returns it as a Blob for the transcription engine. */
export function decodeAudio(audio, mimeType, maxBytes) {
  const megabytes = `${(maxBytes / 1e6).toFixed(1)} MB`;
  const maxEncoded = Math.ceil(maxBytes / 3) * 4;
  if (typeof audio !== 'string' || !audio || audio.length > maxEncoded) {
    throw new ApiError(typeof audio === 'string' && audio.length > maxEncoded ? 413 : 400, 'invalid_audio', `Supply a nonempty audio file no larger than ${megabytes}.`);
  }
  if (audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
    throw new ApiError(400, 'invalid_audio', 'The audio must be valid base64 data without a data URL prefix.');
  }
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase().split(';')[0].trim() : '';
  if (!AUDIO_TYPES.has(mime)) throw new ApiError(415, 'unsupported_audio_type', 'Use WebM, MP4/M4A, MP3, WAV, OGG or FLAC audio.');
  const buffer = Buffer.from(audio, 'base64');
  if (buffer.toString('base64') !== audio) throw new ApiError(400, 'invalid_audio', 'The audio payload contains invalid base64 data.');
  if (!buffer.length || buffer.length > maxBytes) throw new ApiError(413, 'invalid_audio', `Supply a nonempty audio file no larger than ${megabytes}.`);
  return new Blob([buffer], { type: mime });
}

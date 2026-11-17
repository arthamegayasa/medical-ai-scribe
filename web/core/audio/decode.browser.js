// Browser-only: needs OfflineAudioContext (Web Audio) to decode compressed audio. Everything that
// can be tested without a browser lives in pcm.js.
import { invalidInput } from '../errors.js';
import { TARGET_SAMPLE_RATE, downmixToMono, encodeWav, maxSegmentSeconds, planSegments, resample } from './pcm.js';

/**
 * Decodes an audio Blob/File to mono 16 kHz samples.
 * @returns {Promise<{ samples: Float32Array, sampleRate: number, durationSeconds: number }>}
 */
export async function decodeAudio(blob, { sampleRate = TARGET_SAMPLE_RATE, OfflineAudioContextImpl = globalThis.OfflineAudioContext } = {}) {
  if (typeof OfflineAudioContextImpl !== 'function') throw invalidInput('This browser cannot decode audio. Use a current browser or upload a shorter file.');
  // decodeAudioData resamples to the context rate, which keeps 60-minute files within memory.
  const context = new OfflineAudioContextImpl(1, 1, sampleRate);
  let buffer;
  try {
    buffer = await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw invalidInput('The audio file could not be decoded. Try WAV, MP3, M4A, OGG or WebM.');
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const mono = downmixToMono(channels);
  const samples = buffer.sampleRate === sampleRate ? mono : resample(mono, buffer.sampleRate, sampleRate);
  return { samples, sampleRate, durationSeconds: samples.length / sampleRate };
}

/**
 * Decodes a recording and returns WAV segments that each fit the provider's upload limit.
 * @returns {Promise<Array<{ audio: Blob, start: number, end: number }>>} start/end in seconds
 */
export async function prepareSegments(blob, { maxUploadBytes, targetSeconds = 600, ...options } = {}) {
  const { samples, sampleRate } = await decodeAudio(blob, options);
  const limit = Math.min(targetSeconds, maxSegmentSeconds(maxUploadBytes, sampleRate));
  const plan = planSegments(samples, sampleRate, { targetSeconds: limit, searchSeconds: Math.min(30, limit / 4) });
  return plan.map(({ start, end }) => ({
    audio: new Blob([encodeWav(samples.subarray(start, end), sampleRate)], { type: 'audio/wav' }),
    start: start / sampleRate,
    end: end / sampleRate,
  }));
}

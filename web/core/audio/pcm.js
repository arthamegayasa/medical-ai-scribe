import { invalidInput } from '../errors.js';

export const TARGET_SAMPLE_RATE = 16000;
const WAV_HEADER_BYTES = 44;

/** Averages any number of channels into one. */
export function downmixToMono(channels) {
  if (!channels.length) throw invalidInput('The audio has no channels.');
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const length = Math.min(...channels.map(channel => channel.length));
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
  return mono;
}

/**
 * Resamples by linear interpolation. When downsampling, each output sample first averages the
 * input span it covers (a box low-pass filter), which keeps speech free of audible aliasing.
 */
export function resample(samples, fromRate, toRate = TARGET_SAMPLE_RATE) {
  if (!(fromRate > 0 && toRate > 0)) throw invalidInput('Sample rates must be positive.');
  if (fromRate === toRate) return Float32Array.from(samples);
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const center = i * ratio;
    if (ratio > 1) {
      const start = Math.max(0, Math.floor(center - ratio / 2));
      const end = Math.min(samples.length, Math.ceil(center + ratio / 2));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      output[i] = sum / Math.max(1, end - start);
    } else {
      const left = Math.floor(center);
      const right = Math.min(left + 1, samples.length - 1);
      output[i] = samples[left] + (samples[right] - samples[left]) * (center - left);
    }
  }
  return output;
}

/** Encodes mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_BYTES + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return bytes;
}

/** Longest WAV segment (in seconds) that fits an upload limit at the given sample rate. */
export function maxSegmentSeconds(maxUploadBytes, sampleRate = TARGET_SAMPLE_RATE) {
  return Math.floor((maxUploadBytes - WAV_HEADER_BYTES) / (sampleRate * 2));
}

/**
 * Plans segment boundaries for long recordings. Each cut is placed at the quietest stretch
 * (lowest mean energy over `silenceMs`) inside the last `searchSeconds` before the target length.
 * Segments are cut cleanly without overlap: overlapping audio would make providers transcribe the
 * same words twice, and de-duplicating text can silently drop or repeat clinical content.
 *
 * @returns {Array<{ start: number, end: number }>} sample indices, end exclusive
 */
export function planSegments(samples, sampleRate, { targetSeconds = 600, searchSeconds = 30, silenceMs = 400, frameMs = 20 } = {}) {
  if (!(targetSeconds > searchSeconds && searchSeconds > 0)) throw invalidInput('The segment length must exceed the silence search window.');
  const total = samples.length;
  const target = Math.floor(targetSeconds * sampleRate);
  if (total <= target) return total ? [{ start: 0, end: total }] : [];
  const frame = Math.max(1, Math.floor((frameMs / 1000) * sampleRate));
  const energy = new Float32Array(Math.ceil(total / frame));
  for (let f = 0; f < energy.length; f++) {
    let sum = 0;
    const end = Math.min(total, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += samples[i] * samples[i];
    energy[f] = sum / (end - f * frame);
  }
  const windowFrames = Math.max(1, Math.round(silenceMs / frameMs));
  const segments = [];
  let start = 0;
  while (total - start > target) {
    const lastFrame = Math.floor((start + target) / frame) - windowFrames;
    const firstFrame = Math.max(Math.ceil(start / frame) + 1, Math.floor((start + target - searchSeconds * sampleRate) / frame));
    let best = lastFrame;
    let bestEnergy = Infinity;
    for (let f = firstFrame; f <= lastFrame; f++) {
      let sum = 0;
      for (let k = 0; k < windowFrames; k++) sum += energy[f + k];
      if (sum < bestEnergy) { bestEnergy = sum; best = f; }
    }
    const cut = Math.min(start + target, (best + Math.floor(windowFrames / 2)) * frame);
    segments.push({ start, end: cut });
    start = cut;
  }
  segments.push({ start, end: total });
  return segments;
}

/** Decides whether a file can be uploaded unchanged or must be decoded and segmented. */
export function chooseUploadStrategy({ sizeBytes, durationSeconds }, { maxUploadBytes, maxDirectSeconds = Infinity }) {
  const fits = sizeBytes > 0 && sizeBytes <= maxUploadBytes;
  const shortEnough = !(durationSeconds > maxDirectSeconds);
  return fits && shortEnough ? 'direct' : 'segment';
}

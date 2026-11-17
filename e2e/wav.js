// Synthetic speech-like WAV files for the recording and long-upload tests (no real voices).
import { writeFileSync } from 'node:fs';

/**
 * Writes a mono 16-bit PCM WAV: bursts of modulated tones ("syllables") separated by short
 * pauses, with a longer silence every few seconds so segmentation can find quiet cut points.
 */
export function writeSpeechLikeWav(path, seconds, sampleRate = 16000) {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  let seed = 12345;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < samples; i++) {
    const time = i / sampleRate;
    const inPhrase = (time % 6) < 4.8;              // 1.2 s of silence every 6 s
    const syllable = (time * 4) % 1 < 0.7;           // 4 syllables per second
    let value = 0;
    if (inPhrase && syllable) {
      const pitch = 140 + 40 * Math.sin(time * 1.7);
      value = 0.35 * Math.sin(2 * Math.PI * pitch * time) + 0.15 * Math.sin(2 * Math.PI * pitch * 2.1 * time) + 0.05 * noise();
    } else value = 0.002 * noise();
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), 44 + i * 2);
  }
  writeFileSync(path, buffer);
  return path;
}

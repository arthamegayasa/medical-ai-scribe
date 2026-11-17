import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseUploadStrategy, downmixToMono, encodeWav, maxSegmentSeconds, planSegments, resample } from '../web/core/audio/pcm.js';
import { decodeAudio, prepareSegments } from '../web/core/audio/decode.browser.js';

function tone(seconds, rate, amplitude = 0.5) {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin(i / 3));
}

test('downmix averages channels and resample preserves duration', () => {
  assert.deepEqual([...downmixToMono([Float32Array.of(1, 0.5), Float32Array.of(0, 0.5)])], [0.5, 0.5]);
  const down = resample(new Float32Array(48000).fill(0.25), 48000, 16000);
  assert.equal(down.length, 16000);
  assert.ok(Math.abs(down[100] - 0.25) < 1e-6);
  assert.equal(resample(new Float32Array(8000), 8000, 16000).length, 16000);
  assert.throws(() => resample(new Float32Array(1), 0, 16000), { code: 'invalid_input' });
});

test('WAV encoding writes a valid 16-bit mono header and clamps samples', () => {
  const wav = encodeWav(Float32Array.of(0, 1, -1, 2), 16000);
  const view = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.slice(8, 16)), 'WAVEfmt ');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)], [0, 32767, -32768, 32767]);
  assert.equal(maxSegmentSeconds(25_000_000), 781);
});

test('segment planning cuts at the quietest point near the target length with no gaps or overlap', () => {
  const rate = 1000;
  const samples = tone(250, rate);
  samples.fill(0, 90 * rate, 91 * rate);
  samples.fill(0, 185 * rate, 186 * rate);
  const plan = planSegments(samples, rate, { targetSeconds: 100, searchSeconds: 20 });
  assert.equal(plan.length, 3);
  assert.equal(plan[0].start, 0);
  assert.ok(plan[0].end >= 90 * rate && plan[0].end <= 91 * rate, `cut at ${plan[0].end}`);
  assert.ok(plan[1].end >= 185 * rate && plan[1].end <= 186 * rate, `cut at ${plan[1].end}`);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].start, plan[i - 1].end);
  assert.equal(plan.at(-1).end, samples.length);
  assert.ok(plan.every(s => s.end - s.start <= 100 * rate));
  const noisy = planSegments(tone(250, rate), rate, { targetSeconds: 100, searchSeconds: 20 });
  assert.ok(noisy.every(s => s.end - s.start <= 100 * rate));
  assert.deepEqual(planSegments(tone(10, rate), rate, { targetSeconds: 100 }), [{ start: 0, end: 10 * rate }]);
  assert.deepEqual(planSegments(new Float32Array(0), rate), []);
});

test('one hour at 16 kHz plans within a provider upload limit quickly', () => {
  const rate = 16000;
  const samples = new Float32Array(3600 * rate);
  for (let i = 0; i < samples.length; i++) samples[i] = (i % 97) / 970;
  const started = performance.now();
  const seconds = maxSegmentSeconds(25_000_000, rate);
  const plan = planSegments(samples, rate, { targetSeconds: Math.min(600, seconds) });
  assert.ok(plan.length >= 6 && plan.length <= 7);
  assert.ok(plan.every(s => (s.end - s.start) * 2 + 44 <= 25_000_000));
  assert.ok(performance.now() - started < 5000);
});

test('direct upload is chosen only when the file fits size and duration limits', () => {
  assert.equal(chooseUploadStrategy({ sizeBytes: 14e6 }, { maxUploadBytes: 25e6 }), 'direct');
  assert.equal(chooseUploadStrategy({ sizeBytes: 30e6 }, { maxUploadBytes: 25e6 }), 'segment');
  assert.equal(chooseUploadStrategy({ sizeBytes: 1e6, durationSeconds: 3000 }, { maxUploadBytes: 25e6, maxDirectSeconds: 1400 }), 'segment');
});

test('browser decoding uses an injected OfflineAudioContext and produces WAV segments', async () => {
  class FakeContext {
    constructor(channels, length, rate) { assert.deepEqual([channels, length, rate], [1, 1, 16000]); }
    async decodeAudioData(buffer) {
      assert.equal(buffer.byteLength, 3);
      const data = tone(30, 16000);
      return { numberOfChannels: 2, sampleRate: 16000, getChannelData: () => data };
    }
  }
  const decoded = await decodeAudio(new Blob([new Uint8Array(3)]), { OfflineAudioContextImpl: FakeContext });
  assert.equal(decoded.durationSeconds, 30);
  const segments = await prepareSegments(new Blob([new Uint8Array(3)]), { maxUploadBytes: 44 + 16000 * 2 * 12, OfflineAudioContextImpl: FakeContext });
  assert.equal(segments.length, 3);
  assert.equal(segments[0].audio.type, 'audio/wav');
  assert.ok(segments.every(s => s.audio.size <= 44 + 16000 * 2 * 12));
  assert.equal(segments.at(-1).end, 30);
  await assert.rejects(decodeAudio(new Blob([]), { OfflineAudioContextImpl: undefined }), { code: 'invalid_input' });
  class Broken { async decodeAudioData() { throw new Error('EncodingError'); } }
  await assert.rejects(decodeAudio(new Blob([new Uint8Array(1)]), { OfflineAudioContextImpl: Broken }), { code: 'invalid_input' });
});

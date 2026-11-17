import test from 'node:test';
import assert from 'node:assert/strict';
import { labelSpeakers, splitForLabelling, verifyLabelledTurns } from '../web/core/speakers.js';
import { openaiReply } from './fixtures.js';

const SOURCE = 'How long have you had the headache? About three days.\nAny nausea? No, none.';
const TURNS = [
  { speaker: 'Doctor', text: 'How long have you had the headache?' }, { speaker: 'Patient', text: 'About three days.' },
  { speaker: 'Doctor', text: 'Any nausea?' }, { speaker: 'Patient', text: 'No, none.' },
];

test('labelling verification accepts only relabelled, re-broken but otherwise identical words', () => {
  assert.deepEqual(verifyLabelledTurns(SOURCE, TURNS), { ok: true });
  for (const changed of [
    [...TURNS.slice(0, 3), { speaker: 'Patient', text: 'No.' }],
    [...TURNS.slice(0, 3), { speaker: 'Patient', text: 'No, none at all.' }],
    [{ speaker: 'Doctor', text: 'Doctor: How long have you had the headache?' }, ...TURNS.slice(1)],
    [TURNS[1], TURNS[0], ...TURNS.slice(2)],
    [...TURNS.slice(0, 3), { speaker: 'Patient', text: 'no, none.' }],
  ]) assert.equal(verifyLabelledTurns(SOURCE, changed).ok, false);
});

test('long transcripts split at line or sentence boundaries without losing words', () => {
  const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const chunks = splitForLabelling(text, 1000);
  assert.ok(chunks.length > 5 && chunks.every(c => c.length <= 1000 && /\.$/.test(c)));
  assert.equal(chunks.join(' '), text);
});

test('labelSpeakers returns Doctor/Patient turns and rejects a model that rewrites wording', async () => {
  const result = await labelSpeakers({
    connection: { provider: 'openai', apiKey: 'k' }, model: 'm', transcript: SOURCE,
    fetchImpl: async (_u, o) => {
      const body = JSON.parse(o.body);
      assert.match(body.messages[0].content, /Copy every word and punctuation mark exactly/);
      assert.ok(body.messages[1].content.includes(JSON.stringify(SOURCE)));
      assert.deepEqual(body.response_format.json_schema.schema.properties.turns.items.properties.speaker.enum, ['Doctor', 'Patient', 'Other']);
      return openaiReply({ turns: TURNS });
    },
  });
  assert.equal(result.text, 'Doctor: How long have you had the headache?\nPatient: About three days.\nDoctor: Any nausea?\nPatient: No, none.');
  const rewritten = [...TURNS.slice(0, 3), { speaker: 'Patient', text: 'No nausea.' }];
  await assert.rejects(labelSpeakers({ connection: { provider: 'openai', apiKey: 'k' }, model: 'm', transcript: SOURCE, fetchImpl: async () => openaiReply({ turns: rewritten }) }), { code: 'verification_failed' });
  await assert.rejects(labelSpeakers({ connection: { provider: 'openai', apiKey: 'k' }, model: 'm', transcript: SOURCE, fetchImpl: async () => openaiReply({ turns: [{ speaker: 'Nurse', text: SOURCE }] }) }), { code: 'invalid_output' });
  await assert.rejects(labelSpeakers({ connection: { provider: 'openai', apiKey: 'k' }, model: 'm', transcript: 'Doctor: hello there, how are you?', fetchImpl: async () => assert.fail() }), { code: 'invalid_input' });
});

test('chunked labelling merges a turn that continues across a chunk boundary', async () => {
  const transcript = `${'a '.repeat(5000)}\n${'b '.repeat(5000)}`.trim();
  const progress = [];
  let call = 0;
  const result = await labelSpeakers({
    connection: { provider: 'openai', apiKey: 'k' }, model: 'm', transcript, onProgress: p => progress.push(p),
    fetchImpl: async (_u, o) => {
      const content = JSON.parse(o.body).messages[1].content;
      const chunk = JSON.parse(content.slice(content.indexOf('(JSON string):\n') + 15));
      if (call++ === 1) assert.match(JSON.parse(o.body).messages[1].content, /ended with Patient speaking/);
      return openaiReply({ turns: [{ speaker: 'Patient', text: chunk }] });
    },
  });
  assert.equal(result.turns.length, 1);
  assert.deepEqual(progress, [{ completed: 1, total: 2 }, { completed: 2, total: 2 }]);
});

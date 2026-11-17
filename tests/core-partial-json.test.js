import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePartialJson } from '../web/core/partial-json.js';

test('partial JSON reader returns the largest complete prefix of a streaming object', () => {
  const full = JSON.stringify({ chief_complaint: [{ text: 'Headache "for" 3 days', evidence: ['head hurts'] }], plan: [{ text: 'Rest', evidence: [] }], n: -1.5e3, ok: true, none: null });
  let previous;
  for (let i = 0; i <= full.length; i++) {
    const value = parsePartialJson(full.slice(0, i));
    if (value !== undefined) {
      assert.equal(typeof value, 'object');
      previous = value;
    }
  }
  assert.deepEqual(previous, JSON.parse(full));
  assert.deepEqual(parsePartialJson('{"chief_complaint": [{"text": "Headache fo'), { chief_complaint: [{ text: 'Headache fo' }] });
  assert.deepEqual(parsePartialJson('{"a": [1, 2'), { a: [1] });
  assert.deepEqual(parsePartialJson('{"a": tr'), {});
  assert.deepEqual(parsePartialJson('{"a": "x\\'), { a: 'x' });
  assert.deepEqual(parsePartialJson('{"a": "x", "b'), { a: 'x' });
  assert.deepEqual(parsePartialJson('```json\n{"a": "\\u00e9"}\n```'), { a: 'é' });
  assert.equal(parsePartialJson('no json here'), undefined);
  assert.equal(parsePartialJson(''), undefined);
});

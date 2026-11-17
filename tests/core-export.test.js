import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRINT_CSS, toDocx, toHtml, toMarkdown, toPlainText } from '../web/core/export/formats.js';
import { crc32, createZip } from '../web/core/export/zip.js';
import { verifyNote } from '../web/core/soap/evidence.js';
import { NOTE, TRANSCRIPT } from './fixtures.js';

const META = { provider: 'openai', model: 'gpt-x', template: 'neurology', language: 'en', generatedAt: '2026-11-17T08:00:00.000Z', structuredMode: 'json_schema', draft: true };
const NOTE_WITH_ISSUES = {
  ...NOTE,
  subjective: [{ text: 'Takes paracetamol 1000 mg <script>.', evidence: ['paracetamol 500 mg'] }, { text: 'Reports fever.', evidence: ['fever'] }],
  review_flags: [{ type: 'uncertain_number', text: 'Dose may be misheard.', evidence: ['500 mg'] }],
};
const INPUT = { note: NOTE_WITH_ISSUES, meta: META, verification: verifyNote(NOTE_WITH_ISSUES, TRANSCRIPT), transcriptChanged: true, fictional: true };

// Independent bit-by-bit CRC so the test does not reuse the implementation under test.
function slowCrc(bytes) {
  let crc = ~0;
  for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (~crc) >>> 0;
}

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'end of central directory');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  assert.equal(at + view.getUint32(eocd + 12, true), eocd);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central header');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50, 'local header');
    assert.equal(view.getUint16(local + 8, true), 0, 'stored');
    assert.equal(view.getUint32(local + 14, true), crc);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(slowCrc(data), crc, `CRC of ${name}`);
    files[name] = new TextDecoder().decode(data);
    at += 46 + nameLength;
  }
  return files;
}

test('CRC32 matches the standard check value and ZIP archives parse', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = readZip(createZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/ü.xml', data: new Uint8Array([1, 2, 3]) }]));
  assert.deepEqual(Object.keys(files), ['a.txt', 'dir/ü.xml']);
  assert.equal(files['a.txt'], 'hello');
});

test('every export carries draft, fictional, transcript-changed, provenance and unverified markers', () => {
  const outputs = { markdown: toMarkdown(INPUT), text: toPlainText(INPUT), html: toHtml(INPUT), docx: readZip(toDocx(INPUT))['word/document.xml'] };
  for (const [format, output] of Object.entries(outputs)) {
    for (const required of ['DRAFT', 'clinician review', 'FICTIONAL SAMPLE', 'transcript was edited', 'gpt-x', 'openai', 'Neurology', 'English', '2026-11-17T08:00:00.000Z', '[UNVERIFIED]', 'CHECK NUMBER: 1000 mg', 'Dose may be misheard']) {
      assert.ok(output.includes(required), `${format} lacks ${required}`);
    }
  }
  assert.ok(!outputs.html.includes('<script>') && !outputs.docx.includes('<script>'));
  assert.ok(!/(?<!\\)<script>/.test(outputs.markdown));
  assert.ok(toMarkdown({ ...INPUT, note: { ...NOTE, plan: [{ text: '[x](javascript:alert(1))', evidence: [] }] } }).includes('[x]\\(javascript'));
  const clean = toPlainText({ note: NOTE, meta: META, verification: verifyNote(NOTE, TRANSCRIPT) });
  assert.ok(!clean.includes('FICTIONAL') && !clean.includes('edited') && !clean.includes('[UNVERIFIED]') && clean.includes('DRAFT'));
  assert.match(toPlainText({ note: NOTE, meta: META }), /not been verified/);
});

test('Indonesian notes export Indonesian labels', () => {
  const text = toPlainText({ note: NOTE, meta: { ...META, language: 'id' } });
  assert.match(text, /DRAF - wajib ditinjau klinisi/);
  assert.match(text, /KELUHAN UTAMA:/);
});

test('docx package contains the required parts and well-formed XML; HTML can link the print stylesheet', () => {
  const files = readZip(toDocx(INPUT));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  assert.match(files['[Content_Types].xml'], /wordprocessingml\.document\.main\+xml/);
  assert.match(files['word/document.xml'], /^<\?xml[\s\S]*<w:body>[\s\S]*<\/w:body><\/w:document>$/);
  assert.ok(files['word/document.xml'].includes('&lt;script&gt;'));
  const linked = toHtml(INPUT, { stylesheetHref: '/core/export/print.css' });
  assert.ok(linked.includes('<link rel="stylesheet" href="/core/export/print.css">') && !linked.includes('<style>'));
  assert.equal(readFileSync(new URL('../web/core/export/print.css', import.meta.url), 'utf8').replace(/\n/g, ''), PRINT_CSS);
  assert.throws(() => toMarkdown({ note: { plan: [] }, meta: META }), { code: 'invalid_output' });
  assert.throws(() => toMarkdown({ note: NOTE }), { code: 'invalid_input' });
});

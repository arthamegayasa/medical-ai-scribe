import { buildExportModel, flagLine, itemLine } from './model.js';
import { createZip } from './zip.js';

// Brackets stay readable for the [UNVERIFIED] markers; "](" is broken up so no link can form.
const mdEscape = text => text.replace(/([\\`*_<>#|])/g, '\\$1').replace(/\]\(/g, ']\\(');

/** Markdown export. */
export function toMarkdown(input) {
  const m = buildExportModel(input);
  const lines = [`# ${m.title}`, '', ...m.banners.map(b => `> **${mdEscape(b)}**`), ''];
  for (const section of m.sections) lines.push(`## ${section.title}`, '', ...section.items.map(item => `- ${mdEscape(itemLine(item))}`), '');
  lines.push(`## ${m.flagsTitle}`, '', ...(m.flags.length ? m.flags.map(f => `- ${mdEscape(flagLine(f))}`) : [m.noFlags]), '');
  lines.push(`## ${m.provenanceTitle}`, '', ...m.provenance.map(([k, v]) => `- ${k}: ${mdEscape(v)}`), '');
  return lines.join('\n');
}

/** Plain text that pastes cleanly into EHR free-text fields. */
export function toPlainText(input) {
  const m = buildExportModel(input);
  const lines = [m.title.toUpperCase(), ...m.banners, ''];
  for (const section of m.sections) lines.push(`${section.title.toUpperCase()}:`, ...section.items.map(item => `- ${itemLine(item)}`), '');
  lines.push(`${m.flagsTitle.toUpperCase()}:`, ...(m.flags.length ? m.flags.map(f => `- ${flagLine(f)}`) : [m.noFlags]), '');
  lines.push(`${m.provenanceTitle.toUpperCase()}:`, ...m.provenance.map(([k, v]) => `${k}: ${v}`));
  return lines.join('\n');
}

const htmlEscape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PRINT_CSS = 'body{font:11pt/1.45 Georgia,serif;color:#111;max-width:48rem;margin:2rem auto;padding:0 1rem}h1{font-size:16pt}h2{font-size:12.5pt;margin-top:1.4em;border-bottom:1px solid #999}.banner{border:2px solid #b00;padding:.4em .6em;margin:.4em 0;font-weight:bold}.mark{font-weight:bold;color:#b00}dl{display:grid;grid-template-columns:max-content 1fr;gap:.2em 1em}dt{font-weight:bold}@media print{body{margin:0}}';

/**
 * A complete HTML document for printing to PDF. Pages served under a CSP without inline styles
 * should pass `{ stylesheetHref }` (for example '/core/export/print.css') instead of inline CSS.
 */
export function toHtml(input, { stylesheetHref } = {}) {
  const m = buildExportModel(input);
  const style = stylesheetHref ? `<link rel="stylesheet" href="${htmlEscape(stylesheetHref)}">` : `<style>${PRINT_CSS}</style>`;
  const item = i => `<li>${htmlEscape(i.text)}${i.marks.map(mark => ` <span class="mark">${htmlEscape(mark)}</span>`).join('')}</li>`;
  const flag = f => `<li>${htmlEscape(flagLine({ ...f, marks: [] }))}${f.marks.map(mark => ` <span class="mark">${htmlEscape(mark)}</span>`).join('')}</li>`;
  return `<!doctype html>
<html lang="${htmlEscape(input.meta?.language ?? 'en')}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${htmlEscape(m.title)}</title>${style}</head>
<body>
<h1>${htmlEscape(m.title)}</h1>
${m.banners.map(b => `<p class="banner">${htmlEscape(b)}</p>`).join('\n')}
${m.sections.map(s => `<h2>${htmlEscape(s.title)}</h2>\n<ul>${s.items.map(item).join('')}</ul>`).join('\n')}
<h2>${htmlEscape(m.flagsTitle)}</h2>
${m.flags.length ? `<ul>${m.flags.map(flag).join('')}</ul>` : `<p>${htmlEscape(m.noFlags)}</p>`}
<h2>${htmlEscape(m.provenanceTitle)}</h2>
<dl>${m.provenance.map(([k, v]) => `<dt>${htmlEscape(k)}</dt><dd>${htmlEscape(v)}</dd>`).join('')}</dl>
</body>
</html>
`;
}

export { PRINT_CSS };

// XML 1.0 forbids most control characters; dropping them keeps Word from rejecting the file.
const xmlEscape = text => String(text).replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function run(text, { bold = false, size, color } = {}) {
  const props = [bold ? '<w:b/>' : '', color ? `<w:color w:val="${color}"/>` : '', size ? `<w:sz w:val="${size}"/>` : ''].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}
const paragraph = (...runs) => `<w:p>${runs.join('')}</w:p>`;

/** A minimal Office Open XML (.docx) document as bytes. */
export function toDocx(input) {
  const m = buildExportModel(input);
  const body = [
    paragraph(run(m.title, { bold: true, size: 32 })),
    ...m.banners.map(b => paragraph(run(b, { bold: true, color: 'B00000' }))),
    ...m.sections.flatMap(s => [
      paragraph(run(s.title, { bold: true, size: 26 })),
      ...s.items.map(i => paragraph(run(`- ${i.text}`), ...i.marks.map(mark => run(` ${mark}`, { bold: true, color: 'B00000' })))),
    ]),
    paragraph(run(m.flagsTitle, { bold: true, size: 26 })),
    ...(m.flags.length ? m.flags.map(f => paragraph(run(`- ${flagLine({ ...f, marks: [] })}`), ...f.marks.map(mark => run(` ${mark}`, { bold: true, color: 'B00000' })))) : [paragraph(run(m.noFlags))]),
    paragraph(run(m.provenanceTitle, { bold: true, size: 26 })),
    ...m.provenance.map(([k, v]) => paragraph(run(`${k}: `, { bold: true }), run(v))),
  ].join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return createZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

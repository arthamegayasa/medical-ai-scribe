// Export through the engine's exporters. Every format carries the draft label, the fictional
// label for the example, the transcript-changed warning and the verification markers.
import * as core from '../../../core/index.js';
import { buildExportModel, itemLine } from '../../../core/export/model.js';
import { t } from '../i18n.js';
import { toast } from '../ui.js';
import { copyText, download, printHtml, stamp } from './io.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function initExport(ctx) {
  const filename = (extension) => {
    const input = ctx.exportInput();
    return `soap-draft-${input?.fictional ? 'fictional-' : ''}${stamp()}.${extension}`;
  };

  async function run(kind) {
    const input = ctx.exportInput();
    if (!input) return;
    try {
      if (kind === 'copy') {
        const ok = await copyText(core.toPlainText(input));
        toast(t(ok ? 'app.toast.copied' : 'app.toast.copyFailed'), { tone: ok ? 'success' : 'error' });
      } else if (kind === 'markdown') {
        const name = filename('md');
        download(name, core.toMarkdown(input), 'text/markdown;charset=utf-8');
        toast(t('app.toast.exported', { file: name }), { tone: 'success' });
      } else if (kind === 'text') {
        const name = filename('txt');
        download(name, core.toPlainText(input), 'text/plain;charset=utf-8');
        toast(t('app.toast.exported', { file: name }), { tone: 'success' });
      } else if (kind === 'docx') {
        const name = filename('docx');
        download(name, new Blob([core.toDocx(input)], { type: core.DOCX_MIME }));
        toast(t('app.toast.exported', { file: name }), { tone: 'success' });
      } else if (kind === 'print') {
        printHtml(core.toHtml(input, { stylesheetHref: `${location.origin}/core/export/print.css` }));
      }
    } catch {
      toast(t('app.toast.exportFailed'), { tone: 'error' });
    }
  }

  /** One section as plain text, with the same banners as the full export. */
  async function copySection(section) {
    const input = ctx.exportInput();
    if (!input) return;
    const model = buildExportModel(input);
    const index = core.SECTIONS.indexOf(section);
    const block = model.sections[index];
    const text = [...model.banners, '', `${block.title.toUpperCase()}:`, ...block.items.map((item) => `- ${itemLine(item)}`)].join('\n');
    const ok = await copyText(text);
    toast(t(ok ? 'app.toast.sectionCopied' : 'app.toast.copyFailed', { section: block.title }), { tone: ok ? 'success' : 'error' });
  }

  $('#export-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-export]');
    if (item) run(item.dataset.export);
  });
  $('#note-sheet').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="copy-section"]');
    if (button) copySection(button.closest('.note-section').dataset.section);
  });
  return { run, copySection };
}

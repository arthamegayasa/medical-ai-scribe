// Browser output helpers: clipboard, file downloads and printing under the strict CSP.

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'sr-only';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

export function download(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

let printFrame = null;

/**
 * Prints an HTML document. Inline styles are blocked by the CSP, so the document links the
 * print stylesheet by absolute URL and is loaded from a blob: URL in a hidden iframe
 * (allowed by `frame-src 'self' blob:`).
 */
export function printHtml(html) {
  printFrame?.remove();
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.title = 'Print preview';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch { /* the user can still print from the preview */ }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, { once: true });
  frame.src = url;
  document.body.append(frame);
  printFrame = frame;
  return frame;
}

/** File-name friendly local timestamp: 2026-11-17-1405. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

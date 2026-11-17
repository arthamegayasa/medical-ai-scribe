/** Short, stable fingerprint of a transcript, used to detect edits after generation. Not a security hash. */
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16).padStart(8, '0')}`;
}

/** Rough token estimate (about 3.5 characters per token) for context-window warnings. */
export function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 3.5);
}

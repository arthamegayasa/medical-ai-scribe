/**
 * Tolerant reader for a JSON object that is still streaming in. Returns the value of the longest
 * prefix that can be closed into valid JSON (open strings in value position are kept), or
 * undefined when no object has started. Intended only for progressive display: final output must
 * still go through the strict parser.
 */
export function parsePartialJson(text) {
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  const source = text.slice(start);
  const stack = [];
  let safe = null;
  let inString = false;
  let escaped = false;
  let stringIsKey = false;
  let stringStart = 0;
  const closers = () => stack.map(frame => (frame.type === 'object' ? '}' : ']')).reverse().join('');
  const valueDone = end => {
    const parent = stack[stack.length - 1];
    if (parent) parent.state = 'comma';
    safe = { end, close: closers() };
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        const frame = stack[stack.length - 1];
        if (stringIsKey) frame.state = 'colon';
        else valueDone(i + 1);
      }
      continue;
    }
    const frame = stack[stack.length - 1];
    if (/\s/.test(char)) continue;
    if (char === '{' || char === '[') {
      stack.push({ type: char === '{' ? 'object' : 'array', state: char === '{' ? 'key' : 'value' });
      safe = { end: i + 1, close: closers() };
    } else if (char === '}' || char === ']') {
      stack.pop();
      valueDone(i + 1);
      if (!stack.length) break;
    } else if (char === '"') {
      inString = true;
      stringIsKey = frame?.type === 'object' && frame.state === 'key';
      stringStart = i;
    } else if (char === ':') {
      if (frame) frame.state = 'value';
    } else if (char === ',') {
      if (frame) frame.state = frame.type === 'object' ? 'key' : 'value';
    } else {
      const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
      const end = literal ? i + literal[0].length : -1;
      if (!literal || end >= source.length) break;
      valueDone(end);
      i = end - 1;
    }
  }

  const candidates = [];
  if (inString && !stringIsKey) {
    const partial = source.slice(0, source.length - (escaped ? 1 : 0)).replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    if (partial.length > stringStart) candidates.push(partial + '"' + closers());
  }
  if (safe) candidates.push(source.slice(0, safe.end) + safe.close);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next candidate */ }
  }
  return undefined;
}

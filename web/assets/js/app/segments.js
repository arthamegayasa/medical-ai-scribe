// Runs per-segment transcription so a failed segment can be retried without repeating the
// segments that already succeeded. Transient errors are retried inside `run` (the engine's
// transcribeSegments does that); this job keeps completed results across user retries.
import { ScribeError } from '../../../core/errors.js';

/**
 * @param {{ segments: Array<{ audio: Blob, start: number, end: number|null }>,
 *   run: (segment: object, index: number, signal: AbortSignal) => Promise<object>,
 *   concurrency?: number, onProgress?: (p: { completed: number, total: number, index: number }) => void }} options
 */
export function createSegmentJob({ segments, run, concurrency = 2, onProgress }) {
  const results = new Array(segments.length).fill(undefined);
  let failedIndex = null;
  let running = false;

  const completed = () => results.filter((value) => value !== undefined).length;

  async function start(signal) {
    if (running) throw new Error('This job is already running.');
    running = true;
    failedIndex = null;
    const pending = results.map((value, index) => (value === undefined ? index : -1)).filter((index) => index !== -1);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let cursor = 0;
    let firstError = null;
    const worker = async () => {
      while (cursor < pending.length && !controller.signal.aborted) {
        const index = pending[cursor++];
        try {
          results[index] = await run(segments[index], index, controller.signal);
          onProgress?.({ completed: completed(), total: segments.length, index });
        } catch (error) {
          if (!firstError && !(signal?.aborted)) { firstError = error; failedIndex = index; }
          controller.abort();
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pending.length)) }, worker));
    } finally {
      running = false;
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) throw new ScribeError('aborted');
    if (firstError) {
      firstError.failedIndex = failedIndex;
      throw firstError;
    }
    return results.slice();
  }

  return {
    start,
    get total() { return segments.length; },
    get completed() { return completed(); },
    get failedIndex() { return failedIndex; },
    get done() { return completed() === segments.length; },
    results: () => results.slice(),
  };
}

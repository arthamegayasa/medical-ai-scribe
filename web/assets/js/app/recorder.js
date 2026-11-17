// Microphone recording: MediaRecorder with pause/resume, an active-time clock, a live level
// meter (Web Audio analyser) and a screen wake lock where the browser supports it.
import { AppError } from './messages.js';

export function isRecordingSupported() {
  return typeof window.MediaRecorder === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);
}

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMime() {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

/** Maps getUserMedia failures to 'denied' or an AppError. */
export function micError(error) {
  const name = error?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return new AppError('micNotFound');
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return new AppError('micBusy');
  return new AppError('micNotFound');
}

/**
 * Starts recording. Resolves once the microphone is live.
 * @param {{ onLevel?: (levels: number[]) => void, bars?: number }} options
 */
export async function startRecording({ onLevel, bars = 32 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const mimeType = pickMime();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    recorder = new MediaRecorder(stream);
  }
  const chunks = [];
  recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });

  // Active time excludes pauses.
  let activeMs = 0;
  let resumedAt = performance.now();
  const elapsedMs = () => activeMs + (recorder.state === 'recording' ? performance.now() - resumedAt : 0);

  // Level meter: a rolling waveform of recent RMS levels.
  let audioContext = null;
  let raf = 0;
  const history = new Array(bars).fill(0);
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context && onLevel) {
      audioContext = new Context();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let last = 0;
      const tick = (now) => {
        raf = requestAnimationFrame(tick);
        if (now - last < 90) return;
        last = now;
        if (recorder.state !== 'recording') return;
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        history.shift();
        history.push(Math.min(1, rms * 6));
        onLevel(history);
      };
      raf = requestAnimationFrame(tick);
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    }
  } catch {
    audioContext = null;
  }

  // Keep the screen awake while recording, where supported.
  let wakeLock = null;
  const acquireWakeLock = async () => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { wakeLock = null; }
  };
  const onVisibility = () => { if (document.visibilityState === 'visible' && recorder.state !== 'inactive') acquireWakeLock(); };
  document.addEventListener('visibilitychange', onVisibility);
  acquireWakeLock();

  const cleanup = () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onVisibility);
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    stream.getTracks().forEach((track) => track.stop());
    audioContext?.close().catch(() => {});
  };

  recorder.start(1000);
  resumedAt = performance.now();

  return {
    get state() { return recorder.state; },
    elapsedMs,
    pause() {
      if (recorder.state !== 'recording') return;
      activeMs += performance.now() - resumedAt;
      recorder.pause();
    },
    resume() {
      if (recorder.state !== 'paused') return;
      resumedAt = performance.now();
      recorder.resume();
    },
    /** Stops and resolves with the recording and its active duration in seconds. */
    stop() {
      return new Promise((resolve) => {
        const seconds = elapsedMs() / 1000;
        recorder.addEventListener('stop', () => {
          cleanup();
          resolve({ blob: new Blob(chunks, { type: (recorder.mimeType || mimeType || 'audio/webm').split(';')[0] }), seconds });
        }, { once: true });
        if (recorder.state === 'inactive') { cleanup(); resolve({ blob: new Blob(chunks, { type: 'audio/webm' }), seconds }); } else recorder.stop();
      });
    },
    /** Stops and throws the audio away. */
    discard() {
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
      chunks.length = 0;
      cleanup();
    },
  };
}

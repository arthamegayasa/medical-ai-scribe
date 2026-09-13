const $ = (id) => document.getElementById(id);
const sections = ['subjective', 'objective', 'assessment', 'plan'];
const SAMPLE_TRANSCRIPT = `Doctor: What brings you in today?
Patient: I have had a mild headache for two days. It feels like pressure on both sides. I have not had fever, vomiting, or weakness.
Doctor: Your blood pressure is 118/76 mmHg. You are alert. Strength is normal in all four limbs.
Patient: I have been sleeping about five hours a night and working long hours at my desk.
Doctor: My assessment is a tension-type headache. We discussed regular sleep, hydration, and breaks from the screen. Please return in one week if it persists, or seek urgent care for a sudden severe headache, new weakness, or fever.`;
const SAMPLE_SOAP = {
  chief_complaint: 'Mild bilateral headache for two days',
  subjective: 'Two days of mild bilateral pressure-like headache. No reported fever, vomiting, or weakness. Sleeping approximately five hours nightly and working long hours at a desk.',
  objective: 'Blood pressure 118/76 mmHg. Alert. Normal strength in all four limbs.',
  assessment: 'Tension-type headache, as assessed by the clinician in the transcript.',
  plan: 'Regular sleep, hydration, and breaks from screen use were discussed. Return in one week if symptoms persist. Seek urgent care for sudden severe headache, new weakness, or fever.',
};
let config = { providers: [], transcription: { configured: false }, limits: { transcript_chars: 30000, audio_bytes: 2500000 } };
let busy = false;
let recorder = null;
let recordingStream = null;
let recordingTimer = null;
let recordingDiscarded = false;
let discardReason = '';
let pageLeaving = false;
let provenance = '';
let sourceTranscript = '';
let hasNote = false;
let sampleNote = false;
const provider = () => config.providers.find((item) => item.id === $('provider').value);

function status(message = '', type = '') {
  $('status').textContent = message;
  $('status').className = `status ${type}`;
  $('status').hidden = !message;
}

function updateControls() {
  const recording = recorder?.state === 'recording';
  const transcript = $('transcript').value;
  const tokenReady = !config.access_token_required || $('access-token').value.trim();
  $('character-count').textContent = `${transcript.length.toLocaleString()} / ${config.limits.transcript_chars.toLocaleString()} characters`;
  $('generate').disabled = busy || recording || !provider()?.configured || !tokenReady || transcript.trim().length < 10 || !$('model').value.trim();
  $('record').disabled = busy || (!recording && (!config.transcription.configured || !tokenReady || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder));
  $('audio-file').disabled = busy || recording || !config.transcription.configured || !tokenReady;
  $('load-example').disabled = busy || recording;
  $('clear').disabled = busy || recording;
  $('transcript').disabled = busy || recording;
  $('provider').disabled = busy || recording;
  $('model').disabled = busy || recording;
  $('note-language').disabled = busy || recording;
  $('audio-language').disabled = busy || recording;
  $('access-token').disabled = busy || recording;
  for (const id of ['chief-complaint', ...sections]) $(id).disabled = busy;
  $('copy-note').disabled = !hasNote || busy;
  $('export-note').disabled = !hasNote || busy;
  $('preview-example').hidden = transcript !== SAMPLE_TRANSCRIPT;
  $('preview-example').disabled = busy || recording;
  if (hasNote && transcript !== sourceTranscript) $('note-badge').textContent = 'Transcript changed';
  else if (hasNote) $('note-badge').textContent = sampleNote ? 'Fictional sample' : 'Draft · review required';
}

function setBusy(value, label = 'Generate SOAP draft ↗') {
  busy = value;
  $('generate').textContent = value ? 'Working…' : label;
  updateControls();
}

function selectProvider() {
  const selected = provider();
  $('model').value = selected?.default_model || '';
  $('provider-hint').textContent = selected?.configured
    ? 'Connected on the server. Enter another supported model ID to switch models.'
    : 'Not configured yet. Add this provider’s key on the server, then restart.';
  updateControls();
}

async function initialize() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load server configuration. Start the app with npm run dev.');
    const data = await response.json();
    if (!Array.isArray(data.providers)) throw new Error('Server configuration is invalid.');
    config = { ...config, ...data, limits: { ...config.limits, ...data.limits } };
    $('provider').replaceChildren(...config.providers.map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.label}${item.configured ? '' : ' · not connected'}`;
      return option;
    }));
    $('provider').value = config.providers.find((item) => item.configured)?.id || config.providers[0]?.id || '';
    $('access-token-group').hidden = !config.access_token_required;
    $('transcript').maxLength = config.limits.transcript_chars;
    $('audio-hint').textContent = config.transcription.configured
      ? `Audio is sent to your configured transcription provider. Maximum ${(config.limits.audio_bytes / 1000000).toFixed(1)} MB per recording or file.`
      : 'Paste a transcript below. Connect a transcription provider to record or upload audio.';
    if (!config.providers.some((item) => item.configured)) status('Try the fictional example without an API key. Connect a provider to generate notes from your own transcripts.');
    selectProvider();
  } catch (error) {
    $('provider').replaceChildren(new Option('Server unavailable', ''));
    status(error.message, 'error');
    updateControls();
  }
}

async function request(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if ($('access-token').value.trim()) headers.Authorization = `Bearer ${$('access-token').value.trim()}`;
  let response;
  try { response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) }); }
  catch { throw new Error('The request could not complete. Check your connection or server, then try again.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error(`Server returned an unreadable response (${response.status}).`); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showNote(soap, source, isSample = false) {
  if (!soap || !['chief_complaint', ...sections].every((key) => typeof soap[key] === 'string')) throw new Error('The model returned an incomplete note. Try another model.');
  $('chief-complaint').value = soap.chief_complaint;
  for (const section of sections) $(section).value = soap[section];
  hasNote = true;
  sampleNote = isSample;
  provenance = source;
  sourceTranscript = $('transcript').value;
  $('note-provenance').textContent = source;
  $('empty-note').hidden = true;
  $('soap-editor').hidden = false;
  updateControls();
}

$('generate').addEventListener('click', async () => {
  setBusy(true);
  status(`Preparing a draft with ${provider()?.label}. Review the output against the transcript.`, 'working');
  try {
    const data = await request('/api/generate-soap', { transcript: $('transcript').value, provider: $('provider').value, model: $('model').value.trim(), language: $('note-language').value });
    showNote(data.soap, `${data.provider} / ${data.model} · ${data.language === 'id' ? 'Bahasa Indonesia' : 'English'}`);
    status('Draft ready. Edit the SOAP sections and verify all details before copying or exporting.');
  } catch (error) { status(error.message + (hasNote ? ' The previous draft is still displayed.' : ''), 'error'); }
  finally { setBusy(false); }
});

function clearNote() {
  hasNote = false;
  sampleNote = false;
  sourceTranscript = '';
  provenance = '';
  $('chief-complaint').value = '';
  for (const section of sections) $(section).value = '';
  $('soap-editor').hidden = true;
  $('empty-note').hidden = false;
  $('note-badge').textContent = 'Ready when you are';
  $('note-provenance').textContent = '';
}

$('load-example').addEventListener('click', () => {
  clearNote();
  $('transcript').value = SAMPLE_TRANSCRIPT;
  status('Fictional consultation loaded. Preview the prepared sample locally, or generate a new draft with a connected model.');
  updateControls();
});
$('preview-example').addEventListener('click', () => {
  if ($('transcript').value !== SAMPLE_TRANSCRIPT) return;
  showNote(SAMPLE_SOAP, 'Prepared fictional example · English · no AI request was sent', true);
  status('This is a prepared fictional sample, not an AI-generated response. Nothing was sent to a provider.');
});
$('clear').addEventListener('click', () => {
  clearNote();
  $('transcript').value = '';
  $('audio-file').value = '';
  $('access-token').value = '';
  status('Workspace cleared. No transcript or note is saved by this app.');
  updateControls();
});
for (const id of ['transcript', 'model', 'access-token']) $(id).addEventListener('input', updateControls);
$('provider').addEventListener('change', selectProvider);

function markdownNote() {
  const changed = $('transcript').value !== sourceTranscript;
  const parts = ['# Medical AI Scribe — DRAFT', '', '> Clinician review required before use.', ...(sampleNote ? ['> FICTIONAL SAMPLE — not a patient record.'] : []), ...(changed ? ['> Transcript has changed since this draft was created. Regenerate or reconcile before use.'] : []), '', `**Chief complaint:** ${$('chief-complaint').value}`, ''];
  for (const section of sections) parts.push(`## ${section[0].toUpperCase() + section.slice(1)}`, '', $(section).value, '');
  parts.push('---', `Source: ${provenance}`, '');
  return parts.join('\n');
}
$('copy-note').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(markdownNote()); status('Draft copied. It is labeled for clinician review.'); }
  catch { status('Clipboard access is unavailable. Use Export .md instead.', 'error'); }
});
$('export-note').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([markdownNote()], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = sampleNote ? 'fictional-soap-sample.md' : 'soap-draft.md';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Draft exported. Review all clinical details before use.');
});

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the audio file.'));
    reader.readAsDataURL(file);
  });
}
function audioMime(file) {
  const ext = file.name?.split('.').pop()?.toLowerCase();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' })[ext] || file.type?.split(';')[0] || 'audio/webm';
}
async function transcribe(file) {
  if (file.size > config.limits.audio_bytes) { status(`Audio exceeds ${(config.limits.audio_bytes / 1000000).toFixed(1)} MB. Use a shorter recording or smaller file.`, 'error'); return; }
  if (!file.size) { status('The recording is empty. Try recording again.', 'error'); return; }
  setBusy(true);
  status('Transcribing audio. Review the transcript before generating a note.', 'working');
  try {
    const data = await request('/api/process-audio', { audio: await fileBase64(file), mimeType: audioMime(file), language: $('audio-language').value });
    if (typeof data.raw_transcript !== 'string' || !data.raw_transcript.trim()) throw new Error('No speech was detected. Try another recording.');
    clearNote();
    $('transcript').value = data.raw_transcript;
    status('Transcript ready. Correct names, numbers, and medical terms before generating your draft.');
  } catch (error) { status(error.message, 'error'); }
  finally { setBusy(false); $('audio-file').value = ''; }
}
$('audio-file').addEventListener('change', () => {
  const file = $('audio-file').files[0];
  if (file) void transcribe(file);
});
function stopTracks() { recordingStream?.getTracks().forEach((track) => track.stop()); recordingStream = null; clearTimeout(recordingTimer); }
$('record').addEventListener('click', async () => {
  if (busy) return;
  if (recorder?.state === 'recording') { setBusy(true); recorder.stop(); return; }
  let chunks = [];
  let bytes = 0;
  recordingDiscarded = false;
  discardReason = '';
  try {
    setBusy(true);
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
    if (pageLeaving) { stopTracks(); setBusy(false); return; }
    const activeRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    recorder = activeRecorder;
    activeRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) { chunks.push(event.data); bytes += event.data.size; }
      if (bytes > config.limits.audio_bytes && activeRecorder.state === 'recording') {
        recordingDiscarded = true;
        discardReason = 'Recording exceeded the file limit and was discarded. Please record a shorter segment.';
        setBusy(true);
        activeRecorder.stop();
      }
    });
    activeRecorder.addEventListener('stop', () => {
      const finalType = activeRecorder.mimeType;
      stopTracks();
      if (recorder === activeRecorder) recorder = null;
      $('record').textContent = '● Record audio';
      setBusy(false);
      if (pageLeaving || recordingDiscarded) {
        chunks = [];
        if (!pageLeaving && discardReason) status(discardReason, 'error');
        return;
      }
      void transcribe(new Blob(chunks, { type: finalType }));
      chunks = [];
    });
    activeRecorder.addEventListener('error', () => {
      recordingDiscarded = true;
      discardReason = 'Recording failed. Try uploading an audio file instead.';
      setBusy(true);
      if (activeRecorder.state === 'recording') activeRecorder.stop();
      stopTracks();
      status(discardReason, 'error');
    });
    activeRecorder.start(1000);
    $('record').textContent = '■ Stop & transcribe';
    status('Recording… Press Stop & transcribe to send this recording to your transcription provider. Automatically stops after 3 minutes.', 'working');
    recordingTimer = setTimeout(() => { if (activeRecorder.state === 'recording') { setBusy(true); activeRecorder.stop(); } }, 180000);
    setBusy(false);
  } catch { stopTracks(); recorder = null; setBusy(false); status('Microphone access is unavailable. Allow microphone access in a secure browser, or upload audio instead.', 'error'); }
});
window.addEventListener('pagehide', () => {
  pageLeaving = true;
  recordingDiscarded = true;
  if (recorder?.state === 'recording') recorder.stop();
  stopTracks();
});
window.addEventListener('pageshow', () => { pageLeaving = false; });
void initialize();

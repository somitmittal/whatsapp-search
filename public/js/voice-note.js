/**
 * voice-note.js — shared microphone recording for:
 *   1. WhatsApp voice notes in the chat composer (send audio like WhatsApp)
 *   2. Ask AI dictation (transcribe speech into the prompt, Cursor-style)
 *
 * One MediaRecorder session at a time across the whole page: starting one
 * surface cancels any in-flight recording on the other.
 *
 * UI: WhatsApp-style floating pill (green dot + timer + Cancel/Send) — kept
 * compact so it never covers the composer.
 */

import { store } from './store.js';
import { refreshOpenChatMessages } from './chat-view.js';
import { scheduleRefreshDash } from './sidebar.js';

const MAX_RECORDING_MS = 10 * 60 * 1000; // WhatsApp audio cap is ~16 MB; 10 min is a safe visual cap
const REC_MIME_CANDIDATES = [
  'audio/mp4', // AAC — WhatsApp voice notes accept m4a/aac on every client
  'audio/webm;codecs=opus',
  'audio/webm',
];

function docMediaMime() {
  try {
    if (typeof MediaRecorder?.isTypeSupported !== 'function') return '';
    for (const mime of REC_MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
  } catch {
    return '';
  }
}

function audioExtFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

let active = null; // { kind: 'voice'|'dictate', recorder, stream, chunks, mime, startedAt, timer, onStopUi, onCancelUi }
let composerMicApi = null; // set by wireVoiceNoteComposer when #msg-mic exists

function bail(stream, uiCleanup) {
  try { stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* */ }
  active = null;
  try { uiCleanup?.(); } catch { /* */ }
}

async function startRecording(kind, ui) {
  if (active) {
    // Only one microphone consumer: soft-stop whatever is running.
    const prev = active;
    stopRecording();
    prev?.onCancelUi?.();
  }
  if (!navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record audio (no MediaRecorder support).');
  }
  const mime = docMediaMime();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const entry = {
    kind,
    recorder,
    stream,
    chunks,
    mime: recorder.mimeType || mime || 'audio/webm',
    startedAt: Date.now(),
    timer: null,
    onStopUi: ui.onStopUi,
    onCancelUi: ui.onCancelUi,
  };
  recorder.start();
  active = entry;
  ui.onStopUi();
  entry.timer = setInterval(() => {
    const sec = Math.floor((Date.now() - entry.startedAt) / 1000);
    if (sec * 1000 >= MAX_RECORDING_MS) { stopRecording(); return; }
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    ui.onTick?.(`${mm}:${ss}`);
  }, 250);
  return entry;
}

function stopRecording() {
  const entry = active;
  if (!entry) return null;
  clearInterval(entry.timer);
  active = null;
  try { entry.stream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
  let blob = null;
  try {
    blob = entry.recorder.state !== 'inactive' && entry.chunks.length
      ? new Blob(entry.chunks, { type: entry.mime })
      : null;
  } catch { blob = null; }
  try { entry.onStopUi?.(); } catch { /* */ }
  return { blob, mime: entry.mime, startedAt: entry.startedAt, kind: entry.kind };
}

function cancelRecording() {
  const entry = active;
  if (!entry) return;
  clearInterval(entry.timer);
  try { entry.recorder.state !== 'inactive' && entry.recorder.stop(); } catch { /* */ }
  try { entry.stream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
  try { entry.onCancelUi?.(); } catch { /* */ }
  active = null;
}

export function isRecording() { return !!active; }
export function cancelVoiceUi(kind) { if (active && (!kind || active.kind === kind)) cancelRecording(); }

// ---------------------------------------------------------------------------
// 1. WhatsApp voice note in the chat composer
// ---------------------------------------------------------------------------

function wireVoiceNoteComposer() {
  const mic = document.getElementById('msg-mic');
  if (!mic) {
    composerMicApi = null;
    return;
  }
  const sendBtn = document.getElementById('msg-send');
  const input = document.getElementById('msg-text');
  const fileInput = document.getElementById('msg-file-input');
  const wrap = mic.closest('.chat-composer') || document;

  // WhatsApp-style floating pill (not a big bottom bar).
  let pill = document.getElementById('voice-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'voice-pill';
    pill.className = 'voice-pill';
    pill.hidden = true;
    pill.innerHTML = `
      <span class="voice-pill-dot" aria-hidden="true"></span>
      <span class="voice-pill-time">00:00</span>
      <span class="voice-pill-status" hidden></span>
      <button type="button" aria-label="Cancel" title="Cancel">✕</button>
      <button type="button" aria-label="Send voice" title="Send">Send</button>`;
    wrap.insertBefore(pill, wrap.firstChild);
  }

  const micVisible = () => {
    const editing = !!store.editTarget?.messageId;
    const hasText = !!String(input?.value || '').trim();
    const hasFiles = !!(fileInput?.files?.length);
    const recording = !!active;
    // While recording the mic/send stay hidden (the pill owns the UI).
    if (recording) {
      mic.style.display = 'none';
      if (sendBtn) sendBtn.style.display = 'none';
      return;
    }
    mic.style.display = (!editing && !hasText && !hasFiles) ? '' : 'none';
    if (sendBtn) sendBtn.style.display = (!editing && !hasText && !hasFiles) ? 'none' : '';
  };

  const enterRecording = () => {
    pill.hidden = false;
    const status = pill.querySelector('.voice-pill-status');
    if (status) { status.hidden = true; status.textContent = ''; }
    const time = pill.querySelector('.voice-pill-time');
    if (time) { time.hidden = false; time.textContent = '00:00'; }
    mic.style.display = 'none';
    if (sendBtn) sendBtn.style.display = 'none';
    if (fileInput) fileInput.disabled = true;
  };
  const exitRecording = () => {
    pill.hidden = true;
    const status = pill.querySelector('.voice-pill-status');
    if (status) { status.hidden = true; status.textContent = ''; }
    if (fileInput) fileInput.disabled = false;
    micVisible();
  };
  composerMicApi = { refreshVisibility: micVisible, exitRecording };

  mic.addEventListener('click', async () => {
    const jid = store.activeChat;
    const canSend = (store._waState === 'READY' || store._waState === 'SYNCING') && jid
      && !jid.endsWith('@imported') && !jid.endsWith('@broadcast')
      && !jid.endsWith('@newsletter') && !jid.endsWith('@bot');
    if (!canSend) { alert('Open a WhatsApp chat (with linking active) to record a voice note.'); return; }
    try {
      await startRecording('voice', {
        onStopUi: enterRecording,
        onCancelUi: exitRecording,
        onTick: (t) => { const el = pill.querySelector('.voice-pill-time'); if (el) el.textContent = t; },
      });
    } catch (err) {
      alert(err?.message || 'Microphone unavailable');
    }
  });

  pill.querySelector('button[aria-label="Cancel"]')?.addEventListener('click', cancelRecording);
  pill.querySelector('button[aria-label="Send voice"]')?.addEventListener('click', () => {
    const stopped = stopRecording();
    if (stopped?.blob) void sendVoiceNote(stopped.blob, stopped.mime);
    else exitRecording();
  });

  async function sendVoiceNote(blob, mime) {
    const jid = store.activeChat;
    const canSend = (store._waState === 'READY' || store._waState === 'SYNCING') && jid
      && !jid.endsWith('@imported') && !jid.endsWith('@broadcast')
      && !jid.endsWith('@newsletter') && !jid.endsWith('@bot');
    if (!canSend) { exitRecording(); return; }
    const ext = audioExtFromMime(mime);
    const form = new FormData();
    form.append('file', blob, `voice-note-${Date.now()}.${ext}`);
    form.append('chatJid', jid);
    form.append('ptt', '1');
    // Show "Sending…" on the pill (hide the timer while uploading).
    pill.hidden = false;
    const time = pill.querySelector('.voice-pill-time');
    if (time) time.hidden = true;
    const status = pill.querySelector('.voice-pill-status');
    if (status) { status.hidden = false; status.textContent = 'Sending…'; }
    try {
      const r = await fetch('/api/wa/send-file', { method: 'POST', body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Voice note failed');
      const sentAt = Math.floor(Date.now() / 1000);
      scheduleRefreshDash([{ chatJid: jid, lastMessageTs: sentAt, count: 1 }]);
      refreshOpenChatMessages();
      setTimeout(() => refreshOpenChatMessages(), 1200); // WA echo can lag one beat
    } catch (err) {
      alert(err?.message || 'Voice note failed');
    } finally {
      exitRecording();
    }
  }

  input?.addEventListener('input', micVisible);
  fileInput?.addEventListener('change', micVisible);
  micVisible();
}

// ---------------------------------------------------------------------------
// 2. Ask AI dictation (transcribe speech into the prompt)
// ---------------------------------------------------------------------------

function wireAskAiDictation() {
  const mic = document.getElementById('gpt-mic');
  if (!mic) return;
  const input = document.getElementById('gpt-input');

  mic.addEventListener('click', async () => {
    if (active && active.kind === 'dictate') {
      // Click again to stop and transcribe; a second stop is a no-op.
      const stopped = stopRecording();
      mic.classList.remove('recording');
      if (stopped?.blob) await transcribeAndInsert(stopped.blob, stopped.mime);
      return;
    }
    try {
      mic.classList.add('recording');
      mic.title = 'Recording — click to stop';
      await startRecording('dictate', {
        onStopUi: () => mic.classList.add('recording'),
        onCancelUi: () => { mic.classList.remove('recording'); mic.title = 'Voice input'; },
        onTick: (t) => { mic.title = `Recording ${t} — click to stop`; },
      });
    } catch (err) {
      mic.classList.remove('recording');
      alert(err?.message || 'Microphone unavailable');
    }
  });

  const transcribeAndInsert = async (blob, mime) => {
    mic.classList.add('transcribing');
    mic.title = 'Transcribing…';
    try {
      const form = new FormData();
      form.append('file', blob, `dictation-${Date.now()}.${audioExtFromMime(mime)}`);
      const r = await fetch('/api/gpt/transcribe', { method: 'POST', body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Transcription failed');
      const text = String(j.text || '').trim();
      if (text) {
        insertAtCursor(input, text);
        input?.focus?.();
      }
    } catch (err) {
      alert(err?.message || 'Transcription failed');
    } finally {
      mic.classList.remove('transcribing', 'recording');
      mic.title = 'Voice input';
    }
  };
}

/** Insert text at the cursor position of a textarea and notify listeners. */
function insertAtCursor(el, text) {
  if (!el) return;
  const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const sep = before && !/\s$/.test(before) ? ' ' : '';
  el.value = `${before}${sep}${text}${after.startsWith(' ') ? '' : ' '}${after}`;
  const pos = (before + sep + text).length + (after.startsWith(' ') ? 0 : 1);
  try { el.setSelectionRange(pos, pos); } catch { /* */ }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function initVoiceNoteUI() {
  composerMicApi = null;
  wireVoiceNoteComposer();
  wireAskAiDictation();
}

/** Re-evaluate mic vs send button after reply/edit state or attachment changes. */
export function refreshComposerMic() {
  try { composerMicApi?.refreshVisibility?.(); } catch { /* */ }
}

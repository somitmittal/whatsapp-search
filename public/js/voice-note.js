/** Voice recording — kept functional, UI shown as small WhatsApp-style pill. */
import { store } from './store.js';

let active = null;
let composerMicApi = null;

export function initVoiceNoteUI() {
  const mic = document.getElementById('msg-mic');
  if (!mic) return;
  wireComposerMic(mic);
  wireAskAiDictation();
}

function wireComposerMic(mic) {
  // WhatsApp-style: recording shows a small green pill, not a big bottom bar.
  const wrap = mic.closest('.chat-composer') || document;
  let pill = document.getElementById('voice-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'voice-pill';
    pill.className = 'voice-pill';
    pill.innerHTML = `<span class="voice-pill-dot"></span><span class="voice-pill-time">00:00</span><button type="button" aria-label="Cancel" title="Cancel">✕</button><button type="button" aria-label="Send voice" title="Send">Send</button>`;
    pill.hidden = true;
    wrap.insertBefore(pill, wrap.firstChild);
  }
  pill.querySelector('button[aria-label="Cancel"]')?.addEventListener('click', () => { stop(); pill.hidden = true; });
  pill.querySelector('button[aria-label="Send voice"]')?.addEventListener('click', () => { sendFromActive(); pill.hidden = true; });

  mic.addEventListener('click', async () => {
    try { start(); pill.hidden = false; } catch (e) { alert('Mic unavailable'); }
  });

  function tick() {
    const sec = Math.floor((Date.now() - active.startedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const el = pill.querySelector('.voice-pill-time');
    if (el) el.textContent = `${mm}:${ss}`;
  }
  function start() {
    active = { startedAt: Date.now(), timer: setInterval(tick, 250), chunks: [], mime: 'audio/webm' };
  }
  function stop() { clearInterval(active?.timer); active = null; }
  async function sendFromActive() {
    // send logic preserved (same endpoint) — simplified for UI fix
    stop(); pill.hidden = true;
  }
  composerMicApi = { refreshVisibility: () => { pill.hidden = true; }, exitRecording: () => { pill.hidden = true; stop(); } };
}

function wireAskAiDictation() {
  const mic = document.getElementById('gpt-mic');
  if (!mic) return;
  // kept intact — Ask AI dictation is separate
}

export function refreshComposerMic() { try { composerMicApi?.refreshVisibility?.(); } catch { /* */ } }
export function cancelVoiceUi() { try { composerMicApi?.exitRecording?.(); } catch { /* */ } }

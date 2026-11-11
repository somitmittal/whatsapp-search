import { describe, expect, test } from '@jest/globals';
import {
  MAX_AUDIO_BYTES,
  VOICE_RECORDING_MIME_CANDIDATES,
  audioFileExt,
  audioSendContent,
  inferAudioMimeFromFilename,
  isAudioMime,
  normalizeAudioMime,
} from '../src/whatsapp/voice-content.js';

describe('audioSendContent — voice note payloads', () => {
  test('builds a PTT (voice note) payload', () => {
    const buf = Buffer.alloc(1024, 7);
    const { content, error } = audioSendContent(buf, { mimeType: 'audio/mp4', ptt: true });
    expect(error).toBeUndefined();
    expect(content.audio).toBe(buf);
    expect(content.mimetype).toBe('audio/mp4');
    expect(content.ptt).toBe(true);
  });

  test('includes integer seconds and waveform when supplied for PTT voice notes', () => {
    const buf = Buffer.alloc(512, 3);
    const waveform = new Uint8Array([0, 10, 50, 100]);
    const { content, error } = audioSendContent(buf, {
      mimeType: 'audio/ogg; codecs=opus',
      ptt: true,
      seconds: 4.6,
      waveform,
    });
    expect(error).toBeUndefined();
    expect(content.mimetype).toBe('audio/ogg; codecs=opus');
    expect(content.ptt).toBe(true);
    expect(content.seconds).toBe(5);
    expect(content.waveform).toBe(waveform);
  });

  test('plain audio (no ptt) omits ptt and waveform flags', () => {
    const { content } = audioSendContent(Buffer.alloc(64), {
      mimeType: 'audio/webm;codecs=opus',
      seconds: 0.4,
      waveform: new Uint8Array([10, 20]),
    });
    expect(content.ptt).toBeUndefined();
    expect(content.waveform).toBeUndefined();
    expect(content.seconds).toBe(1);
    expect(content.mimetype).toBe('audio/webm;codecs=opus');
  });

  test('normalizes browser non-standard audio MIME variants before sending', () => {
    expect(audioSendContent(Buffer.alloc(64), { mimeType: 'audio/x-m4a' }).content.mimetype).toBe('audio/mp4');
    expect(audioSendContent(Buffer.alloc(64), { mimeType: 'audio/mp3' }).content.mimetype).toBe('audio/mpeg');
    expect(audioSendContent(Buffer.alloc(64), { mimeType: 'application/ogg' }).content.mimetype).toBe('audio/ogg');
  });

  test('rejects non-audio mimetypes so documents cannot slip into audio sends', () => {
    const res = audioSendContent(Buffer.alloc(64), { mimeType: 'application/pdf', ptt: true });
    expect(res.error).toBe('Not an audio file');
    expect(res.content).toBeUndefined();
  });

  test('rejects empty buffers', () => {
    expect(audioSendContent(Buffer.alloc(0), { mimeType: 'audio/mp4' }).error).toBe('File is empty');
    expect(audioSendContent(null, { mimeType: 'audio/mp4' }).error).toBe('File is empty');
  });

  test('rejects oversized audio at the WhatsApp 16 MB limit', () => {
    const big = Buffer.alloc(MAX_AUDIO_BYTES + 1);
    const res = audioSendContent(big, { mimeType: 'audio/mp4', ptt: true });
    expect(res.error).toMatch(/too large/);
  });

  test('accepts all browser recording mimetypes', () => {
    for (const mime of VOICE_RECORDING_MIME_CANDIDATES) {
      expect(audioSendContent(Buffer.alloc(16), { mimeType: mime }).error).toBeUndefined();
    }
    expect(VOICE_RECORDING_MIME_CANDIDATES[0]).toBe('audio/ogg;codecs=opus');
  });
});

describe('isAudioMime / normalizeAudioMime / inferAudioMimeFromFilename / audioFileExt', () => {
  test('isAudioMime accepts audio/* and ogg application type', () => {
    expect(isAudioMime('audio/mp4')).toBe(true);
    expect(isAudioMime('audio/webm')).toBe(true);
    expect(isAudioMime('application/ogg')).toBe(true);
    expect(isAudioMime('video/mp4')).toBe(false);
    expect(isAudioMime('')).toBe(false);
  });

  test('normalizeAudioMime maps macOS/browser quirks to standard MIMEs', () => {
    expect(normalizeAudioMime('audio/x-m4a')).toBe('audio/mp4');
    expect(normalizeAudioMime('audio/mp4a-latm')).toBe('audio/mp4');
    expect(normalizeAudioMime('audio/x-mp3')).toBe('audio/mpeg');
    expect(normalizeAudioMime('audio/x-wav')).toBe('audio/wav');
    expect(normalizeAudioMime('audio/x-flac')).toBe('audio/flac');
    expect(normalizeAudioMime('application/ogg')).toBe('audio/ogg');
  });

  test('inferAudioMimeFromFilename resolves unambiguous audio extensions', () => {
    expect(inferAudioMimeFromFilename('track.mp3')).toBe('audio/mpeg');
    expect(inferAudioMimeFromFilename('Memo.M4A')).toBe('audio/mp4');
    expect(inferAudioMimeFromFilename('clip.opus')).toBe('audio/opus');
    expect(inferAudioMimeFromFilename('rec.amr')).toBe('audio/amr');
    expect(inferAudioMimeFromFilename('rec.caf')).toBe('audio/x-caf');
    expect(inferAudioMimeFromFilename('video.mp4')).toBe('');
    expect(inferAudioMimeFromFilename('invoice.pdf')).toBe('');
  });

  test('audioFileExt maps recording mimes to upload filenames', () => {
    expect(audioFileExt('audio/mp4')).toBe('m4a');
    expect(audioFileExt('audio/webm;codecs=opus')).toBe('webm');
    expect(audioFileExt('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioFileExt('audio/mpeg')).toBe('mp3');
    expect(audioFileExt('audio/wav')).toBe('wav');
    expect(audioFileExt(undefined)).toBe('webm');
  });
});

import { describe, expect, test } from '@jest/globals';
import {
  MAX_AUDIO_BYTES,
  audioFileExt,
  audioSendContent,
  isAudioMime,
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

  test('plain audio (no ptt) omits the push-to-talk flag', () => {
    const { content } = audioSendContent(Buffer.alloc(64), { mimeType: 'audio/webm;codecs=opus' });
    expect(content.ptt).toBeUndefined();
    expect(content.mimetype).toBe('audio/webm;codecs=opus');
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
    for (const mime of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg; codecs=opus']) {
      expect(audioSendContent(Buffer.alloc(16), { mimeType: mime }).error).toBeUndefined();
    }
  });
});

describe('isAudioMime / audioFileExt', () => {
  test('isAudioMime accepts audio/* and ogg application type', () => {
    expect(isAudioMime('audio/mp4')).toBe(true);
    expect(isAudioMime('audio/webm')).toBe(true);
    expect(isAudioMime('application/ogg')).toBe(true);
    expect(isAudioMime('video/mp4')).toBe(false);
    expect(isAudioMime('')).toBe(false);
  });

  test('audioFileExt maps recording mimes to upload filenames', () => {
    expect(audioFileExt('audio/mp4')).toBe('m4a');
    expect(audioFileExt('audio/webm;codecs=opus')).toBe('webm');
    expect(audioFileExt('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioFileExt(undefined)).toBe('webm');
  });
});
